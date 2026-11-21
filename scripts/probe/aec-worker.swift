// aec-worker: probe prototype of the native audio worker (docs/specs/call-audio-redesign.md, migration
// step 1). Not shipped in the npm package. One VoiceProcessingIO unit owns the mic AND the speaker, so
// macOS cancels what we play out of what the mic hears. No VAD, no whisper, no policy: those stay in Node.
//
//   aec-worker [--no-aec]
//   stdin   JSON lines (every command may carry "seq"; it is answered with {ev:"ack",seq,op,status})
//             {op:"play",id,rate}            start a stream of mono s16le PCM at `rate`; optional "gain"
//             {op:"pcm",id,b64}              append PCM to that stream
//             {op:"end",id}                  no more PCM: `done` follows once it has played out
//             {op:"play",id,file}            play an audio file (anything AVAudioFile reads)
//             {op:"gain",id,value,rampMs}    linear ramp to `value` (default 10 ms)
//             {op:"pause",id} {op:"resume",id} {op:"stop",id}
//             {op:"aec",on}                  voice processing on, or bypassed
//             {op:"agc",on}                  the unit's automatic gain control
//             {op:"duck-others",level,advanced}   level: default|min|mid|max (macOS 14+)
//             {op:"info"}                    emit a `devices` event now
//   stdout  mic audio only: 16 kHz mono s16le in whole 30 ms frames (960 bytes), the bytes `rec` gives
//   fd 3    JSON lines: ready, devices, pos (every 100 ms per playing sound), done, ack, error, mic-closed
//           (stderr when fd 3 isn't open, so it can be run by hand)
//   stdin EOF: stop the unit, emit mic-closed, exit 0.
//
// shortcut: the audio callbacks take an NSLock and signal a semaphore, as the spike did (measured fine
// there). Move to lock-free rings if the shipped worker ever shows dropouts.
import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

signal(SIGPIPE, SIG_IGN)

let eventFd: Int32 = fcntl(3, F_GETFD) != -1 ? 3 : 2
let eventQueue = DispatchQueue(label: "events")
func emit(_ event: [String: Any]) {
  guard var line = try? JSONSerialization.data(withJSONObject: event) else { return }
  line.append(0x0A)
  eventQueue.async { line.withUnsafeBytes { _ = write(eventFd, $0.baseAddress, $0.count) } }
}

func fail(_ stage: String, _ status: OSStatus, _ message: String) -> Never {
  emit(["ev": "error", "stage": stage, "status": Int(status), "message": message])
  eventQueue.sync {}
  exit(1)
}

// --- Devices: name, transport (built-in, Bluetooth…) and sample rate of the default input and output ---
func fourCC(_ v: UInt32) -> String {
  String(bytes: [24, 16, 8, 0].map { UInt8((v >> $0) & 0xFF) }, encoding: .ascii)?.trimmingCharacters(in: .whitespaces) ?? "\(v)"
}

func device(_ selector: AudioObjectPropertySelector) -> [String: Any] {
  func address(_ s: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: s, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  }
  var id = AudioDeviceID(0)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  var addr = address(selector)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id) == noErr, id != 0 else {
    return ["name": "none"]
  }
  var name: Unmanaged<CFString>?
  size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  addr = address(kAudioObjectPropertyName)
  AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &name)
  var transport: UInt32 = 0
  size = 4
  addr = address(kAudioDevicePropertyTransportType)
  AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &transport)
  var rate: Float64 = 0
  size = 8
  addr = address(kAudioDevicePropertyNominalSampleRate)
  AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &rate)
  return [
    "name": (name?.takeRetainedValue() as String?) ?? "unknown",
    "transport": fourCC(transport),
    "bluetooth": transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE,
    "rate": rate,
  ]
}

func emitDevices(_ when: String) {
  emit(["ev": "devices", "when": when, "input": device(kAudioHardwarePropertyDefaultInputDevice), "output": device(kAudioHardwarePropertyDefaultOutputDevice)])
}

// --- Sample-rate conversion, streaming: the converter keeps its filter state between calls ---
final class Resampler {
  let converter: AVAudioConverter
  let from: AVAudioFormat
  let to: AVAudioFormat
  init?(from: AVAudioFormat, to: AVAudioFormat) {
    guard let c = AVAudioConverter(from: from, to: to) else { return nil }
    converter = c
    self.from = from
    self.to = to
  }
  /// Convert `input`; with `flush`, also drain what the filter still holds.
  func run(_ input: AVAudioPCMBuffer?, flush: Bool = false) -> AVAudioPCMBuffer {
    let capacity = AVAudioFrameCount(Double(input?.frameLength ?? 0) * to.sampleRate / from.sampleRate) + 4096
    let out = AVAudioPCMBuffer(pcmFormat: to, frameCapacity: capacity)!
    var fed = input == nil
    var error: NSError?
    _ = converter.convert(to: out, error: &error) { _, status in
      if fed {
        status.pointee = flush ? .endOfStream : .noDataNow
        return nil
      }
      fed = true
      status.pointee = .haveData
      return input
    }
    return out
  }
}

func floatFormat(_ rate: Double) -> AVAudioFormat {
  AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
}
func int16Format(_ rate: Double) -> AVAudioFormat {
  AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: false)!
}
func floats(_ buffer: AVAudioPCMBuffer) -> [Float] {
  Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
}

// --- Playback: sounds mixed by the speaker callback ---
final class Sound {
  let id: Int
  var samples: [Float] = []  // at the unit's rate
  var position = 0
  var gain: Float
  var targetGain: Float
  var gainStep: Float = 0
  var paused = false
  var ended = false  // no more samples are coming
  var resampler: Resampler?
  init(id: Int, gain: Float) {
    self.id = id
    self.gain = gain
    targetGain = gain
  }
}

let lock = NSLock()
var sounds: [Sound] = []
var unitRate = 48000.0
var unit: AudioUnit?

let renderProc: AURenderCallback = { _, _, _, _, frames, ioData in
  guard let buffers = UnsafeMutableAudioBufferListPointer(ioData), let data = buffers[0].mData else { return noErr }
  let out = data.assumingMemoryBound(to: Float.self)
  let n = Int(frames)
  for i in 0..<n { out[i] = 0 }
  lock.lock()
  for sound in sounds where !sound.paused {
    var i = 0
    while i < n && sound.position < sound.samples.count {
      if sound.gain != sound.targetGain {
        sound.gain += sound.gainStep
        if sound.gainStep == 0 || (sound.gainStep > 0) == (sound.gain >= sound.targetGain) { sound.gain = sound.targetGain }
      }
      out[i] += sound.samples[sound.position] * sound.gain
      sound.position += 1
      i += 1
    }
  }
  lock.unlock()
  return noErr
}

// --- Mic: the unit's audio goes into a fixed ring; a writer thread resamples it to 16 kHz frames on stdout ---
let ringCapacity = 48000 * 2
let ring = UnsafeMutablePointer<Float>.allocate(capacity: ringCapacity)
var ringStart = 0
var ringCount = 0
var ringOverruns = 0
let ringLock = NSLock()
let micReady = DispatchSemaphore(value: 0)
let micScratch = UnsafeMutablePointer<Float>.allocate(capacity: 16384)
var micErrors = 0

let inputProc: AURenderCallback = { _, flags, timeStamp, _, frames, _ in
  guard let unit else { return noErr }
  let n = Int(frames)
  if n == 0 || n > 16384 { return noErr }
  var list = AudioBufferList(
    mNumberBuffers: 1,
    mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(n * 4), mData: UnsafeMutableRawPointer(micScratch)))
  let status = AudioUnitRender(unit, flags, timeStamp, 1, frames, &list)
  if status != noErr {
    micErrors += 1
    if micErrors == 1 { emit(["ev": "error", "stage": "run", "status": Int(status), "message": "reading the mic failed"]) }
    return status
  }
  ringLock.lock()
  if ringCount + n > ringCapacity {  // the reader stalled: drop what is waiting, keep the newest
    ringStart = 0
    ringCount = 0
    ringOverruns += 1
  }
  for i in 0..<n { ring[(ringStart + ringCount + i) % ringCapacity] = micScratch[i] }
  ringCount += n
  ringLock.unlock()
  micReady.signal()
  return noErr
}

let frameBytes = 960  // 30 ms at 16 kHz, 16-bit mono
func micWriter() {
  guard let resampler = Resampler(from: floatFormat(unitRate), to: int16Format(16000)) else { fail("start", -1, "no converter for the mic") }
  var pending = Data()
  var reportedOverruns = 0
  while true {
    micReady.wait()
    ringLock.lock()
    let n = ringCount
    let input = AVAudioPCMBuffer(pcmFormat: resampler.from, frameCapacity: AVAudioFrameCount(max(n, 1)))!
    let dst = input.floatChannelData![0]
    for i in 0..<n { dst[i] = ring[(ringStart + i) % ringCapacity] }
    ringStart = (ringStart + n) % ringCapacity
    ringCount = 0
    let overruns = ringOverruns
    ringLock.unlock()
    if overruns != reportedOverruns {
      reportedOverruns = overruns
      emit(["ev": "error", "stage": "run", "status": 0, "message": "mic audio dropped: stdout was not read fast enough"])
    }
    if n == 0 { continue }
    input.frameLength = AVAudioFrameCount(n)
    let out = resampler.run(input)
    pending.append(UnsafeBufferPointer(start: out.int16ChannelData![0], count: Int(out.frameLength)))
    let whole = pending.count / frameBytes * frameBytes
    if whole == 0 { continue }
    let wrote = pending.withUnsafeBytes { bytes -> Bool in
      var off = 0
      while off < whole {
        let w = write(1, bytes.baseAddress! + off, whole - off)
        if w <= 0 { return false }
        off += w
      }
      return true
    }
    if !wrote { return }  // the reader is gone; stdin EOF ends the process
    pending.removeSubrange(0..<whole)
  }
}

// --- The voice-processing unit (set up as in the spike) ---
func set<T>(_ unit: AudioUnit, _ property: AudioUnitPropertyID, _ scope: AudioUnitScope, _ element: AudioUnitElement, _ value: T) -> OSStatus {
  withUnsafePointer(to: value) { AudioUnitSetProperty(unit, property, scope, element, $0, UInt32(MemoryLayout<T>.size)) }
}

func makeUnit(rate: Double, aec: Bool) -> (AudioUnit?, String, OSStatus) {
  var desc = AudioComponentDescription(
    componentType: kAudioUnitType_Output, componentSubType: kAudioUnitSubType_VoiceProcessingIO,
    componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
  guard let component = AudioComponentFindNext(nil, &desc) else { return (nil, "finding the voice-processing unit", -1) }
  var made: AudioUnit?
  let created = AudioComponentInstanceNew(component, &made)
  guard created == noErr, let u = made else { return (nil, "creating the unit", created) }
  // Mic and speaker sides must use the SAME format, or it fails with -10875.
  let format = AudioStreamBasicDescription(
    mSampleRate: rate, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
    mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
  let steps: [(String, () -> OSStatus)] = [
    ("enabling the mic", { set(u, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, UInt32(1)) }),
    ("enabling the speakers", { set(u, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, UInt32(1)) }),
    ("setting bypass", { set(u, kAUVoiceIOProperty_BypassVoiceProcessing, kAudioUnitScope_Global, 0, UInt32(aec ? 0 : 1)) }),
    ("setting the mic format", { set(u, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, format) }),
    ("setting the speaker format", { set(u, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, format) }),
    ("setting the mic callback", { set(u, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, AURenderCallbackStruct(inputProc: inputProc, inputProcRefCon: nil)) }),
    ("setting the speaker callback", { set(u, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, AURenderCallbackStruct(inputProc: renderProc, inputProcRefCon: nil)) }),
    ("initializing at \(Int(rate)) Hz", { AudioUnitInitialize(u) }),
  ]
  for (what, step) in steps {
    let status = step()
    if status != noErr {
      AudioComponentInstanceDispose(u)
      return (nil, what, status)
    }
  }
  return (u, "", noErr)
}

func setDucking(level: String, advanced: Bool) -> OSStatus {
  guard let unit else { return -1 }
  guard #available(macOS 14.0, *) else { return kAudioUnitErr_InvalidProperty }
  let levels: [String: AUVoiceIOOtherAudioDuckingLevel] = ["default": .default, "min": .min, "mid": .mid, "max": .max]
  guard let duckingLevel = levels[level] else { return kAudioUnitErr_InvalidPropertyValue }
  return set(unit, kAUVoiceIOProperty_OtherAudioDuckingConfiguration, kAudioUnitScope_Global, 0,
    AUVoiceIOOtherAudioDuckingConfiguration(mEnableAdvancedDucking: DarwinBoolean(advanced), mDuckingLevel: duckingLevel))
}

// --- Commands ---
func finish(_ sound: Sound, _ end: String) {
  emit(["ev": "done", "id": sound.id, "end": end, "ms": Int(Double(sound.position) / unitRate * 1000)])
}

func withSound(_ id: Int, _ body: (Sound) -> Void) -> OSStatus {
  lock.lock()
  defer { lock.unlock() }
  guard let sound = sounds.first(where: { $0.id == id }) else { return -1 }
  body(sound)
  return noErr
}

/// Returns an OSStatus for the ack: 0 = applied, -1 = unknown sound or bad arguments.
func apply(_ c: [String: Any]) -> OSStatus {
  let id = c["id"] as? Int ?? -1
  switch c["op"] as? String ?? "" {
  case "play":
    let sound = Sound(id: id, gain: Float(c["gain"] as? Double ?? 1))
    if let path = c["file"] as? String {
      guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)),
        let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
        (try? file.read(into: buffer)) != nil,
        let resampler = Resampler(from: file.processingFormat, to: floatFormat(unitRate))
      else { return -1 }
      sound.samples = floats(resampler.run(buffer, flush: true))
      sound.ended = true
    } else {
      guard let rate = c["rate"] as? Double, rate >= 8000, let resampler = Resampler(from: int16Format(rate), to: floatFormat(unitRate)) else { return -1 }
      sound.resampler = resampler
    }
    lock.lock()
    sounds.removeAll { $0.id == id }
    sounds.append(sound)
    lock.unlock()
    return noErr
  case "pcm":
    guard let b64 = c["b64"] as? String, let bytes = Data(base64Encoded: b64), bytes.count >= 2 else { return -1 }
    lock.lock()
    let resampler = sounds.first { $0.id == id }?.resampler
    lock.unlock()
    guard let resampler else { return -1 }
    let count = bytes.count / 2
    let input = AVAudioPCMBuffer(pcmFormat: resampler.from, frameCapacity: AVAudioFrameCount(count))!
    input.frameLength = AVAudioFrameCount(count)
    bytes.withUnsafeBytes { input.int16ChannelData![0].update(from: $0.bindMemory(to: Int16.self).baseAddress!, count: count) }
    let more = floats(resampler.run(input))
    return withSound(id) { $0.samples.append(contentsOf: more) }
  case "end":
    lock.lock()
    let resampler = sounds.first { $0.id == id }?.resampler
    lock.unlock()
    guard let resampler else { return -1 }
    let tail = floats(resampler.run(nil, flush: true))
    return withSound(id) {
      $0.samples.append(contentsOf: tail)
      $0.ended = true
    }
  case "gain":
    guard let value = c["value"] as? Double else { return -1 }
    let rampSamples = Float((c["rampMs"] as? Double ?? 10) / 1000 * unitRate)
    return withSound(id) {
      $0.targetGain = Float(value)
      $0.gainStep = rampSamples >= 1 ? ($0.targetGain - $0.gain) / rampSamples : 0
    }
  case "pause": return withSound(id) { $0.paused = true }
  case "resume": return withSound(id) { $0.paused = false }
  case "stop":
    lock.lock()
    let sound = sounds.first { $0.id == id }
    sounds.removeAll { $0.id == id }
    lock.unlock()
    guard let sound else { return -1 }
    finish(sound, "stopped")
    return noErr
  case "aec":
    guard let unit, let on = c["on"] as? Bool else { return -1 }
    return set(unit, kAUVoiceIOProperty_BypassVoiceProcessing, kAudioUnitScope_Global, 0, UInt32(on ? 0 : 1))
  case "agc":
    guard let unit, let on = c["on"] as? Bool else { return -1 }
    return set(unit, kAUVoiceIOProperty_VoiceProcessingEnableAGC, kAudioUnitScope_Global, 0, UInt32(on ? 1 : 0))
  case "duck-others":
    return setDucking(level: c["level"] as? String ?? "", advanced: c["advanced"] as? Bool ?? false)
  case "info":
    emitDevices("now")
    return noErr
  default:
    return -1
  }
}

// --- Main ---
let useAEC = !CommandLine.arguments.contains("--no-aec")
let auth = AVCaptureDevice.authorizationStatus(for: .audio)
if auth == .notDetermined {
  let asked = DispatchSemaphore(value: 0)
  AVCaptureDevice.requestAccess(for: .audio) { _ in asked.signal() }
  asked.wait()
}
let micAuth = ["notDetermined", "restricted", "denied", "authorized"][AVCaptureDevice.authorizationStatus(for: .audio).rawValue]
if micAuth != "authorized" { fail("permission", 0, "microphone access is \(micAuth) for the app that started this process") }

emitDevices("before")
var lastFailure = ("", OSStatus(noErr))
for rate in [48000.0, 24000.0, 16000.0] {
  let (made, what, status) = makeUnit(rate: rate, aec: useAEC)
  guard let made else {
    lastFailure = (what, status)
    continue
  }
  unitRate = rate
  unit = made
  let started = AudioOutputUnitStart(made)
  if started == noErr { break }
  lastFailure = ("starting at \(Int(rate)) Hz", started)
  AudioUnitUninitialize(made)
  AudioComponentInstanceDispose(made)
  unit = nil
}
guard let running = unit else { fail("start", lastFailure.1, lastFailure.0) }
Thread.detachNewThread { micWriter() }
emit(["ev": "ready", "rate": unitRate, "aec": useAEC, "micAuth": micAuth])
emitDevices("after")

let ticker = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "positions"))
ticker.schedule(deadline: .now() + 0.1, repeating: 0.1)
ticker.setEventHandler {
  lock.lock()
  let finished = sounds.filter { $0.ended && $0.position >= $0.samples.count }
  sounds.removeAll { $0.ended && $0.position >= $0.samples.count }
  let playing = sounds.filter { !$0.paused && $0.position > 0 }.map { ($0.id, Int(Double($0.position) / unitRate * 1000)) }
  lock.unlock()
  for sound in finished { finish(sound, "finished") }
  for (id, ms) in playing { emit(["ev": "pos", "id": id, "ms": ms]) }
}
ticker.resume()

Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    // Malformed lines are dropped: this is the boundary, and a bad line must never stop the audio.
    guard let data = line.data(using: .utf8), let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
    let status = apply(command)
    if let seq = command["seq"] as? Int { emit(["ev": "ack", "seq": seq, "op": command["op"] as? String ?? "", "status": Int(status)]) }
  }
  AudioOutputUnitStop(running)
  AudioUnitUninitialize(running)
  AudioComponentInstanceDispose(running)
  emit(["ev": "mic-closed"])
  eventQueue.sync {}
  exit(0)
}
dispatchMain()
