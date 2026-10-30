// Floating call bubble spike for mac-voice-mcp (not shipped in the npm package).
//
// A small always-on-top call pill, like FaceTime's: a frosted dark capsule with Claude's animated
// blob on the left and two round buttons, mute and hang up. It shows while a call is on, whatever
// app or desktop is in front, and never takes focus. It reads the same files as Voice Buddy:
// voice-mode/call.json (a call is on) and voice-mode/phase.json ("speaking", or gone when quiet).
// - Click the blob: brings the window running the call (terminal or IDE) to the front.
// - Mute: creates voice-mode/mute; the server's mic hears nothing while it exists.
// - Hang up: removes call.json, which the server treats as an end.
// - Drag anywhere else to move it.
//
// Build, then run (leave it running, then start a call):
//   swiftc -O scripts/bubble-spike.swift -o /tmp/bubble-spike
//   /tmp/bubble-spike
import AppKit

let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cache/mac-voice-mcp/voice-mode")
let callFile = dir.appendingPathComponent("call.json")
let phaseFile = dir.appendingPathComponent("phase.json")
let muteFile = dir.appendingPathComponent("mute")

// Same colours as Voice Buddy's blob.ts.
let speaking = NSColor(red: 0xd9 / 255.0, green: 0x77 / 255.0, blue: 0x57 / 255.0, alpha: 1)
let listening = NSColor(red: 0x4f / 255.0, green: 0x9d / 255.0, blue: 0xde / 255.0, alpha: 1)
let mutedGrey = NSColor(white: 0.55, alpha: 1)

let height: CGFloat = 56
let pad: CGFloat = 8
let orb: CGFloat = height - 2 * pad
let button: CGFloat = 36
let gap: CGFloat = 10
let width = pad + orb + 14 + button + gap + button + pad + 2

func symbol(_ name: String, _ label: String, _ color: NSColor) -> NSImage {
  NSImage(systemSymbolName: name, accessibilityDescription: label)!
    .withSymbolConfiguration(.init(pointSize: 14, weight: .semibold).applying(.init(paletteColors: [color])))!
}

func isMuted() -> Bool { FileManager.default.fileExists(atPath: muteFile.path) }

final class Pill: NSView {
  var color = listening
  var talking = false
  var t: CGFloat = 0
  var hover: NSRect? = nil
  var dragged = false

  let orbRect = NSRect(x: pad, y: pad, width: orb, height: orb)
  let muteRect = NSRect(x: pad + orb + 14, y: (height - button) / 2, width: button, height: button)
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

/** The app hosting the call's MCP server (its terminal or IDE): walk up from call.json's pid. */
func bringClaudeForward() {
  let call = (try? JSONSerialization.jsonObject(with: Data(contentsOf: callFile))) as? [String: Any]
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

let screen = NSScreen.main!.visibleFrame
let panel = NSPanel(
  contentRect: NSRect(x: screen.maxX - width - 16, y: screen.maxY - height - 16, width: width, height: height),
  styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
panel.level = .floating
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
panel.isOpaque = false
panel.backgroundColor = .clear
panel.hasShadow = true
panel.hidesOnDeactivate = false

// Frosted dark capsule, like FaceTime's and the Dynamic Island's.
let glass = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: width, height: height))
glass.material = .hudWindow
glass.appearance = NSAppearance(named: .darkAqua)
glass.state = .active
glass.blendingMode = .behindWindow
glass.wantsLayer = true
glass.layer!.cornerRadius = height / 2
glass.layer!.masksToBounds = true
let pill = Pill(frame: glass.bounds)
glass.addSubview(pill)
panel.contentView = glass

var shown = false
Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { _ in
  let onCall = FileManager.default.fileExists(atPath: callFile.path)
  if onCall != shown {
    shown = onCall
    onCall ? panel.orderFrontRegardless() : panel.orderOut(nil)
    panel.invalidateShadow()
  }
  guard onCall else { return }
  let phase = (try? JSONSerialization.jsonObject(with: Data(contentsOf: phaseFile))) as? [String: Any]
  pill.talking = phase?["phase"] as? String == "speaking"
  let target = pill.talking ? speaking : isMuted() ? mutedGrey : listening
  pill.color = pill.color.blended(withFraction: 0.15, of: target) ?? target
  pill.t += pill.talking ? 1.6 / 30 : 1.0 / 30
  pill.needsDisplay = true
}
print("Bubble running: it shows while a call is on. Ctrl-C to quit.")
app.run()
