// audio-worker: the native audio backend of a call (docs/specs/call-audio-redesign.md). One macOS
// voice-processing unit owns the mic AND the speaker, so macOS cancels what we play from what the
// mic hears. No speech detection, no whisper, no rules: those stay in Node. Built on the user's Mac
// by src/native-build.ts. The wire protocol is defined once, in src/audio/protocol.ts; this file
// mirrors it and test/audio-worker-contract.test.mjs keeps the two in step.
//
//   audio-worker [--no-aec] [--no-device]
//   stdin   one JSON command per line, each with "seq"; each is answered by an `ack` event
//   stdout  mic audio only: 16 kHz mono s16le in whole 30 ms frames (960 bytes), the bytes `rec` gives.
//           Never blocks: a frame the reader has no room for is dropped and counted (`frames-dropped`)
//   fd 3    one JSON event per line (stderr when fd 3 isn't open, so it can be run by hand)
//   stdin EOF or SIGTERM: fade out, stop the unit, `mic-closed`, exit 0
//
// --no-device swaps the unit for a loop that feeds what is played straight back as mic audio, in
// real time. The contract test uses it: no microphone, no permission, no sound. There, SIGUSR1 acts
// as an output device change and SIGUSR2 stalls the mic.
//
// Threads. The audio callbacks take no lock and allocate nothing: they talk to the rest through
// single-reader single-writer rings and atomics. Everything else (commands, events, resampling, the
// stdout writes) runs on one serial queue, `control`, which also ticks every 5 ms.
//
// Needs macOS 15 and Swift 6 for the Synchronization module's atomics.
import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation
import Synchronization

let protocolVersion = 1
let frameBytes = 960
let tickMs = 5
let fadeMs = 8.0
let posEveryNs: UInt64 = 100_000_000
let micStallNs: UInt64 = 2_000_000_000
let dropReportNs: UInt64 = 1_000_000_000
let maxGain = 2.0
let maxCallbackFrames = 16384

// --- Events ---------------------------------------------------------------------------------

let eventFd: Int32 = fcntl(3, F_GETFD) == -1 ? 2 : 3

func emit(_ event: [String: Any]) {
    guard var line = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]) else { return }
    line.append(0x0A)
    line.withUnsafeBytes { bytes in
        var off = 0
        while off < bytes.count {
            let w = write(eventFd, bytes.baseAddress! + off, bytes.count - off)
            if w > 0 { off += w } else if errno != EINTR { return }
        }
    }
}

// --- What the audio threads share with the control queue --------------------------------------

/// A ring of samples with one writer thread and one reader thread, and no lock.
final class Ring {
    private let buffer: UnsafeMutablePointer<Float>
    private let capacity: Int
    private let readIndex = Atomic<Int>(0)
    private let writeIndex = Atomic<Int>(0)

    init(capacity: Int) {
        precondition(capacity & (capacity - 1) == 0)
        self.capacity = capacity
        buffer = .allocate(capacity: capacity)
    }

    var count: Int { writeIndex.load(ordering: .acquiring) - readIndex.load(ordering: .acquiring) }
    var space: Int { capacity - count }

    /// The writer's side: all of `n` or nothing.
    func write(_ source: UnsafePointer<Float>, _ n: Int) -> Bool {
        let w = writeIndex.load(ordering: .relaxed)
        guard n <= capacity - (w - readIndex.load(ordering: .acquiring)) else { return false }
        let start = w & (capacity - 1)
        let first = min(n, capacity - start)
        (buffer + start).update(from: source, count: first)
        buffer.update(from: source + first, count: n - first)
        writeIndex.store(w + n, ordering: .releasing)
        return true
    }

    /// The reader's side: copies up to `n` and returns how many.
    func read(_ target: UnsafeMutablePointer<Float>, _ n: Int) -> Int {
        let r = readIndex.load(ordering: .relaxed)
        let take = min(n, writeIndex.load(ordering: .acquiring) - r)
        guard take > 0 else { return 0 }
        let start = r & (capacity - 1)
        let first = min(take, capacity - start)
        target.update(from: buffer + start, count: first)
        (target + first).update(from: buffer, count: take - first)
        readIndex.store(r + take, ordering: .releasing)
        return take
    }

    /// Only while no thread reads or writes it.
    func reset() {
        readIndex.store(0, ordering: .releasing)
        writeIndex.store(0, ordering: .releasing)
    }
}

enum Phase {
    static let free = 0
    /// The render callback owns the voice's render state. Only the control queue sets this.
    static let active = 1
    /// Set by the render callback, which then never touches the voice again.
    static let finished = 2
    static let stopped = 3
}

enum Run {
    static let play = 0
    static let pause = 1
    static let stop = 2
}

/// One sound being played. A fixed set exists from the start, so the render callback never sees one appear.
final class Voice {
    let ring = Ring(capacity: 1 << 16)
    let phase = Atomic<Int>(Phase.free)
    let run = Atomic<Int>(Run.play)
    /// Every sample of the sound is in the ring: empty now means it has played out.
    let drained = Atomic<Bool>(false)
    let targetGain = Atomic<UInt32>(Float(1).bitPattern)
    let rampSamples = Atomic<Int>(1)
    /// Samples the render callback has taken, at the unit's rate.
    let played = Atomic<Int>(0)

    // Render callback only, while active.
    var gain: Float = 1
    var gainTarget: Float = 1
    var gainStep: Float = 0
    /// 1 playing, 0 silent: the short ramp that keeps pause, resume and stop from clicking.
    var fade: Float = 1

    // Control queue only.
    var inUse = false
    var id = 0
    var pending: [Float] = []
    var pendingAt = 0
    var ended = false
    var stopping = false
    var resampler: Resampler?
    var lastPosAt: UInt64 = 0
    var lastPosMs = -1

    var playedMs: Int { Int(Double(played.load(ordering: .relaxed)) * 1000 / unitRate) }

    func start(id: Int, gain: Float, samples: [Float], resampler: Resampler?) {
        self.id = id
        self.resampler = resampler
        pending = samples
        pendingAt = 0
        ended = resampler == nil
        stopping = false
        lastPosAt = 0
        lastPosMs = -1
        ring.reset()
        self.gain = gain
        gainTarget = gain
        gainStep = 0
        fade = 1
        targetGain.store(gain.bitPattern, ordering: .relaxed)
        run.store(Run.play, ordering: .relaxed)
        drained.store(false, ordering: .relaxed)
        played.store(0, ordering: .relaxed)
        inUse = true
        phase.store(Phase.active, ordering: .releasing)
    }

    /// Move waiting samples into the ring, as many as fit.
    func pump() {
        let n = min(ring.space, pending.count - pendingAt)
        if n > 0 {
            pending.withUnsafeBufferPointer { _ = ring.write($0.baseAddress! + pendingAt, n) }
            pendingAt += n
        }
        guard pendingAt == pending.count else { return }
        pending.removeAll()
        pendingAt = 0
        if ended { drained.store(true, ordering: .releasing) }
    }
}

final class Shared {
    /// Counts mic callbacks: the control queue ends the worker when it stops moving.
    let inputTicks = Atomic<Int>(0)
    /// Mic samples lost because the control queue fell behind.
    let droppedSamples = Atomic<Int>(0)
    let stalled = Atomic<Bool>(false)
}

let shared = Shared()
let voices = (0..<8).map { _ in Voice() }
let micRing = Ring(capacity: 1 << 17)
let renderScratch = UnsafeMutablePointer<Float>.allocate(capacity: maxCallbackFrames)
let micScratch = UnsafeMutablePointer<Float>.allocate(capacity: maxCallbackFrames)
var unitRate = 48000.0
var fadeStep: Float = 0
var ioUnit: AudioUnit?

// --- The audio callbacks ----------------------------------------------------------------------

/// Mix every active voice into `out`. Runs on the audio thread.
func render(_ out: UnsafeMutablePointer<Float>, _ n: Int) {
    out.update(repeating: 0, count: n)
    guard n <= maxCallbackFrames else { return }
    for voice in voices where voice.phase.load(ordering: .acquiring) == Phase.active {
        let run = voice.run.load(ordering: .relaxed)
        let fadeTarget: Float = run == Run.play ? 1 : 0
        let target = Float(bitPattern: voice.targetGain.load(ordering: .acquiring))
        if target != voice.gainTarget {
            voice.gainTarget = target
            voice.gainStep = (target - voice.gain) / Float(max(1, voice.rampSamples.load(ordering: .relaxed)))
        }
        // Read before the ring, so "drained and empty" can't miss samples written in between.
        let drained = voice.drained.load(ordering: .acquiring)
        if fadeTarget == 1 || voice.fade > 0 {
            // Fading out takes only the samples the fade needs, so a pause holds the exact position.
            let want = fadeTarget == 1 ? n : min(n, Int((voice.fade / fadeStep).rounded(.up)))
            let got = voice.ring.read(renderScratch, want)
            for i in 0..<got {
                if voice.gain != voice.gainTarget {
                    voice.gain += voice.gainStep
                    if voice.gainStep == 0 || (voice.gainStep > 0) == (voice.gain >= voice.gainTarget) { voice.gain = voice.gainTarget }
                }
                if voice.fade != fadeTarget { voice.fade = fadeTarget == 1 ? min(1, voice.fade + fadeStep) : max(0, voice.fade - fadeStep) }
                out[i] += renderScratch[i] * voice.gain * voice.fade
            }
            // Nothing was sounding, so there is nothing left to fade.
            if got < want && fadeTarget == 0 { voice.fade = 0 }
            if got > 0 { voice.played.add(got, ordering: .relaxed) }
        }
        if drained && voice.ring.count == 0 {
            voice.phase.store(run == Run.stop ? Phase.stopped : Phase.finished, ordering: .releasing)
        } else if run == Run.stop && voice.fade <= 0 {
            voice.phase.store(Phase.stopped, ordering: .releasing)
        }
    }
    for i in 0..<n { out[i] = min(1, max(-1, out[i])) }
}

let renderProc: AURenderCallback = { _, _, _, _, frames, ioData in
    // Not UnsafeMutableAudioBufferListPointer: its generic metadata is instantiated, under a lock, on the first call.
    guard let data = ioData?.pointee.mBuffers.mData else { return noErr }
    render(data.assumingMemoryBound(to: Float.self), Int(frames))
    return noErr
}

let inputProc: AURenderCallback = { _, flags, timeStamp, _, frames, _ in
    let n = Int(frames)
    guard let unit = ioUnit, n > 0, n <= maxCallbackFrames else { return noErr }
    var list = AudioBufferList(
        mNumberBuffers: 1,
        mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(n * 4), mData: UnsafeMutableRawPointer(micScratch)))
    // A failing mic doesn't tick, so the stall check ends the worker.
    guard AudioUnitRender(unit, flags, timeStamp, 1, frames, &list) == noErr else { return noErr }
    if !micRing.write(micScratch, n) { shared.droppedSamples.add(n, ordering: .relaxed) }
    shared.inputTicks.add(1, ordering: .relaxed)
    return noErr
}

/// --no-device: what is played comes straight back as mic audio, 10 ms at a time, in real time.
func runLoopback() {
    let chunk = Int(unitRate / 100)
    let buffer = UnsafeMutablePointer<Float>.allocate(capacity: chunk)
    var next = DispatchTime.now().uptimeNanoseconds
    while true {
        if !shared.stalled.load(ordering: .relaxed) {
            render(buffer, chunk)
            if !micRing.write(buffer, chunk) { shared.droppedSamples.add(chunk, ordering: .relaxed) }
            shared.inputTicks.add(1, ordering: .relaxed)
        }
        next += 10_000_000
        let now = DispatchTime.now().uptimeNanoseconds
        if next > now { usleep(UInt32((next - now) / 1000)) }
    }
}

// --- Sample-rate conversion (control queue) -----------------------------------------------------

func floatFormat(_ rate: Double) -> AVAudioFormat {
    AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
}

func int16Format(_ rate: Double) -> AVAudioFormat {
    AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: false)!
}

/// Streaming: the converter keeps its filter state between calls.
final class Resampler {
    let converter: AVAudioConverter
    let from: AVAudioFormat
    let to: AVAudioFormat

    init?(from: AVAudioFormat, to: AVAudioFormat) {
        guard let converter = AVAudioConverter(from: from, to: to) else { return nil }
        self.converter = converter
        self.from = from
        self.to = to
    }

    /// `flush` ends the stream and returns what the filter still held.
    func run(_ input: AVAudioPCMBuffer?, flush: Bool = false) -> AVAudioPCMBuffer {
        let capacity = AVAudioFrameCount(Double(input?.frameLength ?? 0) * to.sampleRate / from.sampleRate) + 4096
        let out = AVAudioPCMBuffer(pcmFormat: to, frameCapacity: capacity)!
        var given = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if !given, let input, input.frameLength > 0 {
                given = true
                status.pointee = .haveData
                return input
            }
            status.pointee = flush ? .endOfStream : .noDataNow
            return nil
        }
        return out
    }
}

func floats(_ buffer: AVAudioPCMBuffer) -> [Float] {
    Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
}

/// A whole audio file (anything AVAudioFile reads) as samples at the unit's rate.
func decode(_ path: String) -> [Float]? {
    guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)), file.length > 0,
        let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
        (try? file.read(into: buffer)) != nil,
        let resampler = Resampler(from: file.processingFormat, to: floatFormat(unitRate))
    else { return nil }
    return floats(resampler.run(buffer, flush: true))
}

// --- The voice-processing unit ------------------------------------------------------------------

func setProperty<T>(_ unit: AudioUnit, _ id: AudioUnitPropertyID, _ scope: AudioUnitScope, _ element: AudioUnitElement, _ value: T) -> OSStatus {
    withUnsafePointer(to: value) { AudioUnitSetProperty(unit, id, scope, element, $0, UInt32(MemoryLayout<T>.size)) }
}

let duckingLevels: [String: AUVoiceIOOtherAudioDuckingLevel] = ["default": .default, "min": .min, "mid": .mid, "max": .max]

/// How much the unit turns other apps down while it runs.
func setDucking(_ unit: AudioUnit, _ level: AUVoiceIOOtherAudioDuckingLevel) -> OSStatus {
    setProperty(unit, kAUVoiceIOProperty_OtherAudioDuckingConfiguration, kAudioUnitScope_Global, 0,
        AUVoiceIOOtherAudioDuckingConfiguration(mEnableAdvancedDucking: false, mDuckingLevel: level))
}

func makeUnit(rate: Double, aec: Bool) -> (AudioUnit?, String, OSStatus) {
    var description = AudioComponentDescription(
        componentType: kAudioUnitType_Output, componentSubType: kAudioUnitSubType_VoiceProcessingIO,
        componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
    guard let component = AudioComponentFindNext(nil, &description) else { return (nil, "finding the voice-processing unit", -1) }
    var made: AudioUnit?
    let created = AudioComponentInstanceNew(component, &made)
    guard created == noErr, let unit = made else { return (nil, "creating the unit", created) }
    // The mic and speaker sides must use the SAME format, or the unit fails with -10875.
    let format = AudioStreamBasicDescription(
        mSampleRate: rate, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
    let steps: [(String, () -> OSStatus)] = [
        ("enabling the mic", { setProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, UInt32(1)) }),
        ("enabling the speakers", { setProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, UInt32(1)) }),
        ("setting echo cancellation", { setProperty(unit, kAUVoiceIOProperty_BypassVoiceProcessing, kAudioUnitScope_Global, 0, UInt32(aec ? 0 : 1)) }),
        ("setting the mic format", { setProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, format) }),
        ("setting the speaker format", { setProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, format) }),
        ("setting the mic callback", { setProperty(unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, AURenderCallbackStruct(inputProc: inputProc, inputProcRefCon: nil)) }),
        ("setting the speaker callback", { setProperty(unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, AURenderCallbackStruct(inputProc: renderProc, inputProcRefCon: nil)) }),
        ("initializing at \(Int(rate)) Hz", { AudioUnitInitialize(unit) }),
    ]
    for (what, step) in steps {
        let status = step()
        if status != noErr {
            AudioComponentInstanceDispose(unit)
            return (nil, what, status)
        }
    }
    // Before the unit starts: the default turns other apps down hard, and a later change takes 1 to 2 s to apply.
    _ = setDucking(unit, .min)
    return (unit, "", noErr)
}

func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioDeviceID {
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id)
    return id
}

/// The unit is bound to the devices it started on. When either default changes, say so and stop: Node falls back.
func watchRoute() {
    for (which, selector) in [("input", kAudioHardwarePropertyDefaultInputDevice), ("output", kAudioHardwarePropertyDefaultOutputDevice)] {
        let was = defaultDevice(selector)
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, control) { _, _ in
            if defaultDevice(selector) != was { routeChanged(which) }
        }
    }
    // Older Macs keep one built-in output device and switch its source when headphones go in.
    var source = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDataSource, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
    AudioObjectAddPropertyListenerBlock(defaultDevice(kAudioHardwarePropertyDefaultOutputDevice), &source, control) { _, _ in routeChanged("output") }
}

// --- The control queue --------------------------------------------------------------------------

let control = DispatchQueue(label: "control", qos: .userInteractive)
var micResampler: Resampler?
/// Mic audio not yet on stdout: whole frames, then at most one part of a frame.
var micBytes: [UInt8] = []
/// Bytes of the first frame the reader already has.
var headWritten = 0
var stdoutOpen = true
var droppedFrames = 0
var lastDropReportAt: UInt64 = 0
var lastInputTicks = 0
var lastInputAt: UInt64 = 0

func writeFrames() {
    while micBytes.count >= frameBytes {
        let w = micBytes.withUnsafeBytes { write(1, $0.baseAddress! + headWritten, frameBytes - headWritten) }
        if w > 0 {
            headWritten += w
            if headWritten == frameBytes {
                micBytes.removeFirst(frameBytes)
                headWritten = 0
            }
        } else if w < 0 && errno == EINTR {
            continue
        } else if w < 0 && errno == EAGAIN {
            if headWritten == 0 {
                micBytes.removeFirst(frameBytes)
                droppedFrames += 1
                continue
            }
            // The reader has part of this frame, so it must get the rest: only the frames behind it go.
            let behind = micBytes.count / frameBytes - 1
            micBytes.removeSubrange(frameBytes..<frameBytes * (behind + 1))
            droppedFrames += behind
            return
        } else {
            // The reader is gone. stdin EOF ends the process.
            stdoutOpen = false
            micBytes.removeAll()
            return
        }
    }
}

func drainMic() {
    let n = micRing.count
    guard n > 0, let resampler = micResampler, let input = AVAudioPCMBuffer(pcmFormat: resampler.from, frameCapacity: AVAudioFrameCount(n)) else { return }
    input.frameLength = AVAudioFrameCount(micRing.read(input.floatChannelData![0], n))
    guard stdoutOpen else { return }
    let out = resampler.run(input)
    micBytes.append(contentsOf: UnsafeRawBufferPointer(start: out.int16ChannelData![0], count: Int(out.frameLength) * 2))
    writeFrames()
}

func done(_ voice: Voice, _ reason: String) {
    emit(["ev": "done", "id": voice.id, "reason": reason, "playedMs": voice.playedMs])
    voice.inUse = false
    voice.resampler = nil
    voice.pending.removeAll()
    voice.phase.store(Phase.free, ordering: .releasing)
}

func tick() {
    let now = DispatchTime.now().uptimeNanoseconds
    for voice in voices where voice.inUse {
        voice.pump()
        let phase = voice.phase.load(ordering: .acquiring)
        if phase != Phase.active {
            done(voice, phase == Phase.finished ? "finished" : "stopped")
        } else if now - voice.lastPosAt >= posEveryNs, voice.playedMs != voice.lastPosMs {
            voice.lastPosAt = now
            voice.lastPosMs = voice.playedMs
            emit(["ev": "pos", "id": voice.id, "playedMs": voice.lastPosMs])
        }
    }
    drainMic()
    if now - lastDropReportAt >= dropReportNs {
        lastDropReportAt = now
        let lost = Double(shared.droppedSamples.exchange(0, ordering: .relaxed)) / (unitRate * 0.03)
        let count = droppedFrames + Int(lost.rounded(.up))
        droppedFrames = 0
        if count > 0 { emit(["ev": "frames-dropped", "count": count]) }
    }
    let ticks = shared.inputTicks.load(ordering: .relaxed)
    if ticks != lastInputTicks {
        lastInputTicks = ticks
        lastInputAt = now
    } else if now - lastInputAt > micStallNs {
        emit(["ev": "error", "stage": "run", "code": 0, "message": "the microphone stopped delivering audio"])
        shutdown(1)
    }
}

/// Fade out what is playing, stop the unit, settle every sound, and exit.
func shutdown(_ code: Int32) -> Never {
    for voice in voices where voice.inUse { voice.run.store(Run.stop, ordering: .relaxed) }
    if voices.contains(where: { $0.inUse }) { usleep(UInt32(fadeMs * 3 * 1000)) }
    if let unit = ioUnit {
        AudioOutputUnitStop(unit)
        AudioUnitUninitialize(unit)
        AudioComponentInstanceDispose(unit)
    }
    for voice in voices where voice.inUse {
        done(voice, voice.phase.load(ordering: .acquiring) == Phase.finished ? "finished" : "stopped")
    }
    emit(["ev": "mic-closed"])
    exit(code)
}

func routeChanged(_ which: String) {
    emit(["ev": "route-changed", "which": which])
    shutdown(0)
}

enum Reply {
    case ok(Voice?)
    case badCommand
    case unknownId
    case busy
    case failed(OSStatus)
}

func active(_ command: [String: Any]) -> Voice? {
    guard let id = command["id"] as? Int else { return nil }
    return voices.first { $0.inUse && $0.id == id }
}

func status(_ result: OSStatus) -> Reply {
    result == noErr ? .ok(nil) : .failed(result)
}

func run(_ op: String, _ c: [String: Any]) -> Reply {
    switch op {
    case "play":
        guard let id = c["id"] as? Int, active(c) == nil else { return .badCommand }
        guard let voice = voices.first(where: { !$0.inUse }) else { return .busy }
        let gain = Float(min(max(c["gain"] as? Double ?? 1, 0), maxGain))
        if let path = c["file"] as? String {
            guard let samples = decode(path) else { return .failed(-1) }
            voice.start(id: id, gain: gain, samples: samples, resampler: nil)
        } else {
            guard let rate = c["rate"] as? Double, rate >= 8000, rate <= 192_000,
                let resampler = Resampler(from: int16Format(rate), to: floatFormat(unitRate))
            else { return .badCommand }
            voice.start(id: id, gain: gain, samples: [], resampler: resampler)
        }
        return .ok(voice)
    case "pcm":
        guard let b64 = c["b64"] as? String, let bytes = Data(base64Encoded: b64), bytes.count >= 2, bytes.count % 2 == 0 else { return .badCommand }
        guard let voice = active(c), !voice.stopping, !voice.ended, let resampler = voice.resampler else { return .unknownId }
        let count = bytes.count / 2
        let input = AVAudioPCMBuffer(pcmFormat: resampler.from, frameCapacity: AVAudioFrameCount(count))!
        input.frameLength = AVAudioFrameCount(count)
        bytes.copyBytes(to: UnsafeMutableRawBufferPointer(start: input.int16ChannelData![0], count: count * 2))
        voice.pending.append(contentsOf: floats(resampler.run(input)))
        voice.pump()
        return .ok(voice)
    case "end":
        guard let voice = active(c), !voice.stopping, !voice.ended, let resampler = voice.resampler else { return .unknownId }
        voice.pending.append(contentsOf: floats(resampler.run(nil, flush: true)))
        voice.ended = true
        voice.pump()
        return .ok(voice)
    case "gain":
        guard let value = c["value"] as? Double else { return .badCommand }
        guard let voice = active(c) else { return .unknownId }
        let rampMs = min(max(c["rampMs"] as? Double ?? 10, 0), 1000)
        voice.rampSamples.store(max(1, Int(rampMs / 1000 * unitRate)), ordering: .relaxed)
        voice.targetGain.store(Float(min(max(value, 0), maxGain)).bitPattern, ordering: .releasing)
        return .ok(voice)
    case "pause", "resume":
        guard let voice = active(c), !voice.stopping else { return .unknownId }
        voice.run.store(op == "pause" ? Run.pause : Run.play, ordering: .relaxed)
        return .ok(voice)
    case "stop":
        guard let voice = active(c), !voice.stopping else { return .unknownId }
        voice.stopping = true
        voice.pending.removeAll()
        voice.pendingAt = 0
        voice.run.store(Run.stop, ordering: .relaxed)
        return .ok(voice)
    case "aec", "agc":
        guard let on = c["on"] as? Bool else { return .badCommand }
        guard let unit = ioUnit else { return .ok(nil) }
        return status(op == "aec"
            ? setProperty(unit, kAUVoiceIOProperty_BypassVoiceProcessing, kAudioUnitScope_Global, 0, UInt32(on ? 0 : 1))
            : setProperty(unit, kAUVoiceIOProperty_VoiceProcessingEnableAGC, kAudioUnitScope_Global, 0, UInt32(on ? 1 : 0)))
    case "duck-others":
        guard let level = duckingLevels[c["level"] as? String ?? ""] else { return .badCommand }
        guard let unit = ioUnit else { return .ok(nil) }
        return status(setDucking(unit, level))
    default:
        return .badCommand
    }
}

func handle(_ line: String) {
    guard let data = line.data(using: .utf8), let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        let seq = command["seq"] as? Int, let op = command["op"] as? String
    else {
        emit(["ev": "ack", "seq": -1, "op": "", "status": "bad-command"])
        return
    }
    var ack: [String: Any] = ["ev": "ack", "seq": seq, "op": op]
    switch run(op, command) {
    case .ok(let voice):
        ack["status"] = "ok"
        if let voice { ack["playedMs"] = voice.playedMs }
    case .badCommand: ack["status"] = "bad-command"
    case .unknownId: ack["status"] = "unknown-id"
    case .busy: ack["status"] = "busy"
    case .failed(let code):
        ack["status"] = "failed"
        ack["code"] = Int(code)
    }
    emit(ack)
}

// --- Main ---------------------------------------------------------------------------------------

func fail(_ stage: String, _ code: OSStatus, _ message: String) -> Never {
    emit(["ev": "error", "stage": stage, "code": Int(code), "message": message])
    exit(1)
}

signal(SIGPIPE, SIG_IGN)
_ = fcntl(1, F_SETFL, fcntl(1, F_GETFL) | O_NONBLOCK)
let noDevice = CommandLine.arguments.contains("--no-device")
let aec = !CommandLine.arguments.contains("--no-aec")

if noDevice {
    Thread.detachNewThread { runLoopback() }
} else {
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
        let asked = DispatchSemaphore(value: 0)
        AVCaptureDevice.requestAccess(for: .audio) { _ in asked.signal() }
        asked.wait()
    }
    if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
        fail("permission", 0, "microphone access is not granted to the app that started this process")
    }
    var failure = ("starting the unit", OSStatus(-1))
    for rate in [48000.0, 24000.0, 16000.0] {
        let (made, what, status) = makeUnit(rate: rate, aec: aec)
        guard let made else {
            failure = (what, status)
            continue
        }
        unitRate = rate
        ioUnit = made
        let started = AudioOutputUnitStart(made)
        if started == noErr { break }
        failure = ("starting at \(Int(rate)) Hz", started)
        ioUnit = nil
        AudioUnitUninitialize(made)
        AudioComponentInstanceDispose(made)
    }
    if ioUnit == nil { fail("start", failure.1, failure.0) }
}
fadeStep = Float(1000 / (fadeMs * unitRate))
guard let resampler = Resampler(from: floatFormat(unitRate), to: int16Format(16000)) else { fail("start", -1, "no converter for the mic") }
micResampler = resampler

var signals: [DispatchSourceSignal] = []
func on(_ number: Int32, _ handler: @escaping () -> Void) {
    let source = DispatchSource.makeSignalSource(signal: number, queue: control)
    source.setEventHandler(handler: handler)
    source.resume()
    signals.append(source)
}

let ticker = DispatchSource.makeTimerSource(queue: control)
control.sync {
    lastInputAt = DispatchTime.now().uptimeNanoseconds
    emit(["ev": "ready", "v": protocolVersion, "rate": Int(unitRate), "aec": aec])
    // Ignored only from here: until now SIGTERM kills it, so a start that hangs on the permission prompt can be ended.
    signal(SIGTERM, SIG_IGN)
    on(SIGTERM) { shutdown(0) }
    if noDevice {
        signal(SIGUSR1, SIG_IGN)
        signal(SIGUSR2, SIG_IGN)
        on(SIGUSR1) { routeChanged("output") }
        on(SIGUSR2) { shared.stalled.store(true, ordering: .relaxed) }
    } else {
        watchRoute()
    }
    ticker.schedule(deadline: .now(), repeating: .milliseconds(tickMs), leeway: .milliseconds(1))
    ticker.setEventHandler { tick() }
    ticker.resume()
}

Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        if !line.isEmpty { control.async { handle(line) } }
    }
    control.async { shutdown(0) }
}
dispatchMain()
