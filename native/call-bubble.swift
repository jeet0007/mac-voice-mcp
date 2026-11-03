// The floating call bubble for mac-voice-mcp (docs/specs/call-bubble.md).
//
// A small always-on-top call pill, like FaceTime's: a frosted dark capsule with Claude's animated
// blob, the call's duration and two round buttons, mute and hang up. It shows on every desktop,
// whatever app is in front, and never takes focus. voice-mcp's setup builds it on this Mac with
// swiftc (after asking), and the server starts it at call start. It reads the same files as Voice
// Buddy: voice-mode/call.json (the call, while it's on) and voice-mode/phase.json ("speaking").
// A soft glow around the pill follows the mic's level from voice-mode/levels ("<dB> <threshold dB>"):
// blue when the server counts it as speech, grey below that, none while muted, while Claude talks,
// or when the file is stale.
// - Click the blob: brings the window running the call (terminal or IDE) to the front.
// - Mute: creates voice-mode/mute; the server's mic hears nothing while it exists.
// - Hang up: removes call.json, which the server treats as an end.
// - Drag anywhere else to move it; where it was left (the pill's origin) is kept in voice-mode/bubble.json.
// It exits once call.json is gone or the server that wrote it has died.
//
// voice-mcp builds it with: swiftc -O native/call-bubble.swift -o <cache>/bin/call-bubble
import AppKit

extension String { var nilIfEmpty: String? { isEmpty ? nil : self } }

// The same folder as cacheRoot() in hooks/voice-files.mjs, so run it with the server's VOICE_MCP_CACHE_DIR or XDG_CACHE_HOME.
let env = ProcessInfo.processInfo.environment
let cacheDir = env["VOICE_MCP_CACHE_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
  ?? URL(fileURLWithPath: env["XDG_CACHE_HOME"]?.nilIfEmpty ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cache").path)
    .appendingPathComponent("mac-voice-mcp").path
let dir = URL(fileURLWithPath: cacheDir).appendingPathComponent("voice-mode")
let callFile = dir.appendingPathComponent("call.json")
let phaseFile = dir.appendingPathComponent("phase.json")
let placeFile = dir.appendingPathComponent("bubble.json")
let muteFile = dir.appendingPathComponent("mute")
let levelsPath = dir.appendingPathComponent("levels").path

// Same colours as Voice Buddy's blob.ts.
let speaking = NSColor(red: 0xd9 / 255.0, green: 0x77 / 255.0, blue: 0x57 / 255.0, alpha: 1)
let listening = NSColor(red: 0x4f / 255.0, green: 0x9d / 255.0, blue: 0xde / 255.0, alpha: 1)
let mutedGrey = NSColor(white: 0.55, alpha: 1)

let height: CGFloat = 56
let pad: CGFloat = 8
let orb: CGFloat = height - 2 * pad
let button: CGFloat = 36
let gap: CGFloat = 10
let clock: CGFloat = 58
let width = pad + orb + 10 + clock + 4 + button + gap + button + pad + 2
// Room around the pill for its glow and shadow; the panel is the pill plus this on every side.
let margin: CGFloat = 30
let pillPath = NSBezierPath(roundedRect: NSRect(x: margin, y: margin, width: width, height: height), xRadius: height / 2, yRadius: height / 2)

func symbol(_ name: String, _ label: String, _ color: NSColor) -> NSImage {
  NSImage(systemSymbolName: name, accessibilityDescription: label)!
    .withSymbolConfiguration(.init(pointSize: 14, weight: .semibold).applying(.init(paletteColors: [color])))!
}

func isMuted() -> Bool { FileManager.default.fileExists(atPath: muteFile.path) }

func readJSON(_ url: URL) -> [String: Any]? { (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String: Any] }

final class Pill: NSView {
  var color = listening
  var talking = false
  var t: CGFloat = 0
  var hover: NSRect? = nil
  var dragged = false
  var elapsed = "0:00"

  let orbRect = NSRect(x: pad, y: pad, width: orb, height: orb)
  let clockRect = NSRect(x: pad + orb + 10, y: 0, width: clock, height: height)
  let muteRect = NSRect(x: pad + orb + 10 + clock + 4, y: (height - button) / 2, width: button, height: button)
  var hangUpRect: NSRect { muteRect.offsetBy(dx: button + gap, dy: 0) }

  override func updateTrackingAreas() {
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways], owner: self))
  }
  override func mouseMoved(with event: NSEvent) {
    let at = convert(event.locationInWindow, from: nil)
    hover = [orbRect, muteRect, hangUpRect].first { $0.contains(at) }
  }
  override func mouseExited(with event: NSEvent) { hover = nil }

  override func draw(_ dirtyRect: NSRect) {
    // The orb: Claude's blob, wobbling more while it talks.
    let c = CGPoint(x: orbRect.midX, y: orbRect.midY)
    let base = orb * (talking ? 0.44 : 0.40)
    let wobble: CGFloat = talking ? 0.10 : 0.04
    let path = NSBezierPath()
    for i in 0...64 {
      let a = CGFloat(i) / 64 * 2 * .pi
      let r = base * (1 + wobble * (sin(3 * a + t * 2.6) * 0.6 + sin(2 * a - t * 1.7) * 0.4))
      let p = CGPoint(x: c.x + r * cos(a), y: c.y + r * sin(a))
      i == 0 ? path.move(to: p) : path.line(to: p)
    }
    path.close()
    NSGradient(starting: color.blended(withFraction: 0.45, of: .white)!, ending: color.blended(withFraction: 0.15, of: .black)!)!
      .draw(in: path, relativeCenterPosition: NSPoint(x: -0.35, y: 0.35))

    let digits = NSAttributedString(string: elapsed, attributes: [
      .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .medium),
      .foregroundColor: NSColor(white: 1, alpha: 0.85),
    ])
    let size = digits.size()
    digits.draw(at: NSPoint(x: clockRect.midX - size.width / 2, y: clockRect.midY - size.height / 2))

    // Mute: frosted grey, or white with a dark slashed mic while muted (like FaceTime).
    let muted = isMuted()
    var fill = muted ? NSColor.white : NSColor(white: 1, alpha: 0.16)
    if hover == muteRect { fill = muted ? NSColor(white: 0.85, alpha: 1) : NSColor(white: 1, alpha: 0.26) }
    circle(muteRect, fill, symbol(muted ? "mic.slash.fill" : "mic.fill", muted ? "Unmute" : "Mute", muted ? .black : .white))

    // Hang up: red.
    let red = NSColor(red: 1, green: 0.23, blue: 0.19, alpha: 1)
    circle(hangUpRect, hover == hangUpRect ? red.blended(withFraction: 0.15, of: .black)! : red, symbol("phone.down.fill", "Hang up", .white))
  }

  func circle(_ rect: NSRect, _ fill: NSColor, _ icon: NSImage) {
    fill.setFill()
    NSBezierPath(ovalIn: rect).fill()
    let s = icon.size
    icon.draw(in: NSRect(x: rect.midX - s.width / 2, y: rect.midY - s.height / 2, width: s.width, height: s.height))
  }

  override func mouseDown(with event: NSEvent) { dragged = false }
  override func mouseDragged(with event: NSEvent) {
    dragged = true
    window?.performDrag(with: event)
  }
  override func mouseUp(with event: NSEvent) {
    guard !dragged else { return }
    let at = convert(event.locationInWindow, from: nil)
    if hangUpRect.contains(at) {
      try? FileManager.default.removeItem(at: callFile)
    } else if muteRect.contains(at) {
      if isMuted() { try? FileManager.default.removeItem(at: muteFile) } else { FileManager.default.createFile(atPath: muteFile.path, contents: nil) }
    } else if orbRect.contains(at) {
      bringClaudeForward()
    }
  }
}

/** The pill's shadow and the mic-level glow, drawn only outside the pill so the glass never shows them through. */
final class Glow: NSView {
  var level: CGFloat = 0 // 0...1
  var speech: CGFloat = 0 // 0 grey, 1 blue

  override func draw(_ dirtyRect: NSRect) {
    let outside = NSBezierPath(rect: bounds)
    outside.append(pillPath)
    outside.windingRule = .evenOdd
    outside.addClip()
    halo(NSColor(white: 0, alpha: 0.4), blur: 12, dy: -3)
    if level > 0 {
      let color = mutedGrey.blended(withFraction: speech, of: listening)!
      halo(color.withAlphaComponent(min(1, 0.3 + level)), blur: 4 + 26 * level, dy: 0)
    }
  }

  func halo(_ color: NSColor, blur: CGFloat, dy: CGFloat) {
    let shadow = NSShadow()
    shadow.shadowColor = color
    shadow.shadowBlurRadius = blur
    shadow.shadowOffset = NSSize(width: 0, height: dy)
    shadow.set()
    NSColor.black.setFill()
    pillPath.fill()
  }
}

/** The mic's level mapped to 0...1, and whether it's over the speech threshold, if the server wrote it in the last 0.25 s. */
func micLevel() -> (level: CGFloat, speech: Bool)? {
  var st = stat()
  guard stat(levelsPath, &st) == 0,
        Date().timeIntervalSince1970 - (Double(st.st_mtimespec.tv_sec) + Double(st.st_mtimespec.tv_nsec) / 1e9) < 0.25,
        let parts = (try? String(contentsOfFile: levelsPath, encoding: .utf8))?.split(separator: " "), parts.count == 2,
        let db = Double(parts[0]), let threshold = Double(parts[1]) else { return nil }
  return (CGFloat(max(0, min(1, (db + 90) / 80))), db > threshold)
}

/** The app hosting the call's MCP server (its terminal or IDE): walk up from call.json's pid. */
func bringClaudeForward() {
  let call = readJSON(callFile)
  var pid = (call?["pid"] as? NSNumber)?.int32Value ?? 0
  while pid > 1 {
    if let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy == .regular {
      app.activate()
      return
    }
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return }
    pid = info.kp_eproc.e_ppid
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon, no menu bar

/** The pill's frame: where it was left, if that spot is still on a screen; else the top right of the main screen. */
func startFrame() -> NSRect {
  if let place = readJSON(placeFile), let x = place["x"] as? Double, let y = place["y"] as? Double {
    let frame = NSRect(x: x, y: y, width: width, height: height)
    if NSScreen.screens.contains(where: { $0.visibleFrame.contains(NSPoint(x: frame.midX, y: frame.midY)) }) { return frame }
  }
  let screen = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
  return NSRect(x: screen.maxX - width - 16, y: screen.maxY - height - 16, width: width, height: height)
}

let panel = NSPanel(
  contentRect: startFrame().insetBy(dx: -margin, dy: -margin),
  styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
panel.level = .floating
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
panel.isOpaque = false
panel.backgroundColor = .clear
// Off: the window shadow follows content alpha, so it would shadow the glow too. Glow draws the pill's shadow instead.
panel.hasShadow = false
panel.hidesOnDeactivate = false

// Frosted dark capsule, like FaceTime's and the Dynamic Island's.
let glass = NSVisualEffectView(frame: NSRect(x: margin, y: margin, width: width, height: height))
glass.material = .hudWindow
glass.appearance = NSAppearance(named: .darkAqua)
glass.state = .active
glass.blendingMode = .behindWindow
// A mask image (not a layer corner radius) shapes the blurred glass itself into the capsule.
glass.maskImage = NSImage(size: glass.bounds.size, flipped: false) { rect in
  NSBezierPath(roundedRect: rect, xRadius: height / 2, yRadius: height / 2).fill()
  return true
}
let pill = Pill(frame: glass.bounds)
glass.addSubview(pill)
let glow = Glow(frame: NSRect(origin: .zero, size: panel.frame.size))
glow.addSubview(glass)
panel.contentView = glow

NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: panel, queue: .main) { _ in
  let place = try? JSONSerialization.data(withJSONObject: ["x": Double(panel.frame.minX + margin), "y": Double(panel.frame.minY + margin)])
  try? place?.write(to: placeFile, options: .atomic)
}

/** The call's start (ms since 1970), or nil once it's over: call.json gone, or the server that wrote it died. */
func callStart() -> Double? {
  guard let call = readJSON(callFile), let pid = (call["pid"] as? NSNumber)?.int32Value,
        kill(pid, 0) == 0 || errno == EPERM else { return nil }
  return (call["startedAt"] as? NSNumber)?.doubleValue ?? Date().timeIntervalSince1970 * 1000
}

var level: CGFloat = 0
var speech: CGFloat = 0
panel.orderFrontRegardless()
Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { _ in
  guard let started = callStart() else { exit(0) }
  let s = max(0, Int((Date().timeIntervalSince1970 * 1000 - started) / 1000))
  pill.elapsed = s < 3600 ? String(format: "%d:%02d", s / 60, s % 60) : String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
  let phase = readJSON(phaseFile)
  pill.talking = phase?["phase"] as? String == "speaking"
  let muted = isMuted()
  let target = pill.talking ? speaking : muted ? mutedGrey : listening
  pill.color = pill.color.blended(withFraction: 0.15, of: target) ?? target
  pill.t += pill.talking ? 1.6 / 30 : 1.0 / 30
  pill.needsDisplay = true

  let mic = pill.talking || muted ? nil : micLevel()
  level += ((mic?.level ?? 0) - level) * 0.25
  if level < 0.01 { level = 0 }
  if let mic { speech += ((mic.speech ? 1 : 0) - speech) * 0.3 }
  // Redraw the glow only when it would look different; the pill redraws on its own.
  if abs(level - glow.level) > 0.01 || abs(speech - glow.speech) > 0.02 {
    glow.level = level
    glow.speech = speech
    glow.needsDisplay = true
  }
}
app.run()
