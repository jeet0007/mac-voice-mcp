// The floating call pill and its live transcript panel, built on the user's Mac with swiftc. See docs/specs/call-bubble.md.
import AppKit

extension String { var nilIfEmpty: String? { isEmpty ? nil : self } }

// Must match cacheRoot() in hooks/voice-files.mjs.
let demo = CommandLine.arguments.contains("--demo")
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

    let muted = isMuted()
    var fill = muted ? NSColor.white : NSColor(white: 1, alpha: 0.16)
    if hover == muteRect { fill = muted ? NSColor(white: 0.85, alpha: 1) : NSColor(white: 1, alpha: 0.26) }
    circle(muteRect, fill, symbol(muted ? "mic.slash.fill" : "mic.fill", muted ? "Unmute" : "Mute", muted ? .black : .white))

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

// Drawn only outside the pill, so the glass never shows the glow or shadow through.
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

func micLevel() -> (level: CGFloat, speech: Bool)? {
  var st = stat()
  guard stat(levelsPath, &st) == 0,
        Date().timeIntervalSince1970 - (Double(st.st_mtimespec.tv_sec) + Double(st.st_mtimespec.tv_nsec) / 1e9) < 0.25,
        let parts = (try? String(contentsOfFile: levelsPath, encoding: .utf8))?.split(separator: " "), parts.count == 2,
        let db = Double(parts[0]), let threshold = Double(parts[1]) else { return nil }
  return (CGFloat(max(0, min(1, (db + 90) / 80))), db > threshold)
}

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
app.setActivationPolicy(.accessory)

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

let demoStart = Date().timeIntervalSince1970 * 1000
func callStart() -> Double? {
  if demo { return demoStart }
  guard let call = readJSON(callFile), let pid = (call["pid"] as? NSNumber)?.int32Value,
        kill(pid, 0) == 0 || errno == EPERM else { return nil }
  return (call["startedAt"] as? NSNumber)?.doubleValue ?? Date().timeIntervalSince1970 * 1000
}


// MARK: - Live transcript

let tPad: CGFloat = 14
let tPadV: CGFloat = 10
let tLine: CGFloat = 20
let tGap: CGFloat = 8
let tRadius: CGFloat = 16
let tMaxWidth: CGFloat = 360
let tMinWidth: CGFloat = 120
let tMaxLines = 3
let tEdge: CGFloat = 8
let tFont = NSFont.systemFont(ofSize: 15, weight: .regular)

final class TranscriptPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

enum TState { case hidden, partial, final, fading }

final class Transcript {
  let window: TranscriptPanel
  let solid = NSView()
  let glass: NSVisualEffectView
  let hairline = NSView()
  let label = NSTextField(labelWithString: "")
  let ws = NSWorkspace.shared

  var state = TState.hidden
  var raw = ""
  var lastPartial = ""     // survives the idle fade: the same words again must not bring the panel back
  var width: CGFloat = tMinWidth
  var lines = 1
  var below = true
  var cap = tMaxLines
  var work: DispatchWorkItem?
  var generation = 0
  var finalAt = Date.distantPast
  var muted = false
  var wasSpeaking = false

  var reduceMotion: Bool { ws.accessibilityDisplayShouldReduceMotion }
  var highContrast: Bool { ws.accessibilityDisplayShouldIncreaseContrast }
  var reduceTransparency: Bool { ws.accessibilityDisplayShouldReduceTransparency }

  init() {
    window = TranscriptPanel(contentRect: NSRect(x: 0, y: 0, width: tMinWidth, height: tLine + 2 * tPadV),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    window.level = .floating
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    window.sharingType = .none            // screen sharing and recording never show what you say
    window.ignoresMouseEvents = true
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false   // a shadow on this borderless, rounded window shows as a dark outline
    window.hidesOnDeactivate = false
    window.alphaValue = 0

    glass = NSVisualEffectView(frame: window.contentView!.bounds)
    glass.material = .hudWindow
    glass.blendingMode = .behindWindow
    glass.state = .active
    glass.appearance = NSAppearance(named: .darkAqua)
    glass.autoresizingMask = [.width, .height]
    glass.maskImage = NSImage(size: NSSize(width: 2 * tRadius + 1, height: 2 * tRadius + 1), flipped: false) { rect in
      NSBezierPath(roundedRect: rect, xRadius: tRadius, yRadius: tRadius).fill()
      return true
    }
    glass.maskImage?.capInsets = NSEdgeInsets(top: tRadius, left: tRadius, bottom: tRadius, right: tRadius)
    glass.maskImage?.resizingMode = .stretch

    for v in [solid, hairline] {
      v.wantsLayer = true
      v.frame = glass.bounds
      v.autoresizingMask = [.width, .height]
      v.layer?.cornerRadius = tRadius
    }
    solid.isHidden = true

    label.isEditable = false
    label.isSelectable = false
    label.maximumNumberOfLines = tMaxLines
    label.usesSingleLineMode = false
    label.lineBreakMode = .byWordWrapping
    label.cell?.wraps = true
    label.setAccessibilityLabel("Live transcript")
    label.setAccessibilityRole(.staticText)
    label.wantsLayer = true

    let root = window.contentView!
    root.addSubview(glass)
    root.addSubview(solid)
    root.addSubview(hairline)
    root.addSubview(label)
    applyAccessibility()
    NotificationCenter.default.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
      self?.applyAccessibility()
      self?.restyle()
    }
  }

  // MARK: Look

  func applyAccessibility() {
    let flat = highContrast || reduceTransparency
    glass.isHidden = flat
    solid.isHidden = !flat
    solid.layer?.backgroundColor = (highContrast
      ? NSColor(red: 0x1c / 255.0, green: 0x1c / 255.0, blue: 0x1e / 255.0, alpha: 0.95)
      : NSColor(red: 0x2c / 255.0, green: 0x2c / 255.0, blue: 0x2e / 255.0, alpha: 1)).cgColor
    hairline.layer?.borderWidth = highContrast ? 1 : 0.5
    hairline.layer?.borderColor = NSColor(white: 1, alpha: highContrast ? 0.55 : 0.10).cgColor
  }

  var textAlpha: CGFloat { state == .final ? (highContrast ? 1.0 : 0.96) : (highContrast ? 0.85 : 0.72) }

  func attributed(_ text: String) -> NSAttributedString {
    let style = NSMutableParagraphStyle()
    style.minimumLineHeight = tLine
    style.maximumLineHeight = tLine
    style.alignment = .natural
    style.lineBreakMode = .byWordWrapping
    return NSAttributedString(string: text, attributes: [.font: tFont, .paragraphStyle: style, .foregroundColor: NSColor.white])
  }

  /// Measured with a cell like the label's: a bare string measures narrower, and the last word wrapped onto a hidden line.
  let measure: NSTextFieldCell = { let c = NSTextFieldCell(); c.wraps = true; c.lineBreakMode = .byWordWrapping; return c }()
  func sizeOf(_ text: String, width w: CGFloat) -> NSSize {
    measure.attributedStringValue = attributed(text)
    let s = measure.cellSize(forBounds: NSRect(x: 0, y: 0, width: w, height: .greatestFiniteMagnitude))
    return NSSize(width: ceil(s.width), height: ceil(s.height))
  }
  func heightOf(_ text: String, width w: CGFloat) -> CGFloat { sizeOf(text, width: w).height }

  func fit(_ text: String, width w: CGFloat, cap: Int) -> String {
    let limit = CGFloat(cap) * tLine + 0.5
    if heightOf(text, width: w) <= limit { return text }
    let chars = Array(text.suffix(400))
    var lo = 0, hi = chars.count
    while lo < hi {
      let mid = (lo + hi) / 2
      if heightOf("… " + String(chars[mid...]), width: w) <= limit { hi = mid } else { lo = mid + 1 }
    }
    var start = lo
    if start > 0, start < chars.count, let space = chars[start..<min(chars.count, start + 12)].firstIndex(of: " ") { start = space + 1 }
    return "… " + String(chars[min(start, chars.count)...])
  }

  @discardableResult
  func layout(_ text: String) -> NSRect {
    let textWidth = sizeOf(String(text.suffix(400)).replacingOccurrences(of: "\n", with: " "), width: 10_000).width
    let maxW = min(tMaxWidth, (screenVisible().width - 2 * tEdge))
    width = max(width, min(max(textWidth + 2 * tPad, tMinWidth), maxW))
    let inner = width - 2 * tPad
    let shown = fit(text, width: inner, cap: cap)
    lines = max(1, min(cap, Int(round(heightOf(shown, width: inner) / tLine))))
    label.attributedStringValue = attributed(shown)
    label.setAccessibilityValue(shown)
    let size = NSSize(width: width, height: CGFloat(lines) * tLine + 2 * tPadV)
    window.contentView?.setFrameSize(size)
    label.frame = NSRect(x: tPad, y: tPadV, width: inner, height: CGFloat(lines) * tLine)
    return frame(for: size)
  }

  func restyle() { label.alphaValue = textAlpha }

  // MARK: Place

  func pillFrame() -> NSRect { panel.frame.insetBy(dx: margin, dy: margin) }

  func screen() -> NSScreen? {
    let c = NSPoint(x: pillFrame().midX, y: pillFrame().midY)
    return NSScreen.screens.first { $0.frame.contains(c) } ?? NSScreen.main
  }

  func screenVisible() -> NSRect { (screen() ?? NSScreen.screens[0]).visibleFrame }

  func chooseSide() {
    let pill = pillFrame(), vis = screenVisible()
    let full = CGFloat(tMaxLines) * tLine + 2 * tPadV
    if pill.minY - tGap - full >= vis.minY + tEdge { below = true; cap = tMaxLines }
    else if pill.maxY + tGap + full <= vis.maxY - tEdge { below = false; cap = tMaxLines }
    else {
      let roomBelow = pill.minY - tGap - (vis.minY + tEdge)
      let roomAbove = (vis.maxY - tEdge) - (pill.maxY + tGap)
      below = roomBelow >= roomAbove
      cap = max(1, min(tMaxLines, Int(floor(((below ? roomBelow : roomAbove) - 2 * tPadV) / tLine))))
    }
  }

  func frame(for size: NSSize) -> NSRect {
    let pill = pillFrame(), vis = screenVisible()
    var x = pill.midX - size.width / 2
    x = max(vis.minX + tEdge, min(x, vis.maxX - tEdge - size.width))
    let y = below ? pill.minY - tGap - size.height : pill.maxY + tGap
    return NSRect(x: x, y: y, width: size.width, height: size.height)
  }

  func reposition() {
    guard state != .hidden else { return }
    window.setFrame(frame(for: window.frame.size), display: true)
  }

  // MARK: Show and hide

  func fadeDuration(_ d: Double) -> Double { reduceMotion ? 0.1 : d }

  func schedule(after seconds: Double, _ block: @escaping () -> Void) {
    work?.cancel()
    let item = DispatchWorkItem(block: block)
    work = item
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
  }

  func animate(_ duration: Double, ease: CAMediaTimingFunctionName, _ changes: @escaping () -> Void, done: (() -> Void)? = nil) {
    NSAnimationContext.runAnimationGroup({ ctx in
      ctx.duration = duration
      ctx.timingFunction = CAMediaTimingFunction(name: ease)
      ctx.allowsImplicitAnimation = true
      changes()
    }, completionHandler: done)
  }

  func show(_ text: String, isFinal: Bool) {
    generation += 1
    raw = text
    let wasHidden = state == .hidden
    let wasFading = state == .fading
    if wasHidden { width = tMinWidth; chooseSide() }
    state = isFinal ? .final : .partial
    if isFinal { finalAt = Date() }
    let target = layout(text)
    let slide: CGFloat = reduceMotion ? 0 : 6
    if wasHidden {
      var start = target
      start.origin.y += below ? slide : -slide
      window.setFrame(start, display: false)
      window.alphaValue = 0
      panel.addChildWindow(window, ordered: .above)
      window.orderFront(nil)
      restyle()
      animate(fadeDuration(0.12), ease: .easeOut) { self.window.animator().alphaValue = 1; if slide != 0 { self.window.animator().setFrame(target, display: true) } }
      if slide == 0 { window.setFrame(target, display: true) }
    } else {
      if wasFading { animate(fadeDuration(0.08), ease: .easeOut) { self.window.animator().alphaValue = 1 } }
      if reduceMotion {
        window.setFrame(target, display: true)
        label.alphaValue = textAlpha
      } else {
        animate(0.12, ease: .easeOut) {
          self.window.animator().setFrame(target, display: true)
          self.label.animator().alphaValue = self.textAlpha
        }
      }
    }
    let words = text.split { $0 == " " || $0 == "\n" }.count
    if isFinal {
      let hold = min(3.0, 1.5 + 0.1 * Double(max(0, words - 8)))
      schedule(after: hold) { self.fadeOut(0.25) }
    } else {
      schedule(after: 4.0) { self.fadeOut(0.25) }
    }
  }

  func fadeOut(_ duration: Double) {
    guard state != .hidden else { return }
    work?.cancel()
    state = .fading
    generation += 1
    let mine = generation
    animate(fadeDuration(duration), ease: .easeIn, { self.window.animator().alphaValue = 0 }, done: { [weak self] in
      guard let self, self.generation == mine, self.state == .fading else { return }
      self.hideNow()
    })
  }

  func hideNow() {
    work?.cancel()
    generation += 1
    state = .hidden
    raw = ""
    width = tMinWidth
    window.alphaValue = 0
    panel.removeChildWindow(window)
    window.orderOut(nil)
    label.attributedStringValue = NSAttributedString(string: "")
    label.setAccessibilityValue("")
  }

  // MARK: Events

  func partial(_ text: String) {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if muted || t.isEmpty { return }
    if state == .final, Date().timeIntervalSince(finalAt) < 0.4 { return }   // a late reply to the utterance just finished
    if t == lastPartial { return }
    lastPartial = t
    show(t, isFinal: false)
  }

  func final(_ text: String) {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if muted || t.isEmpty { return }
    lastPartial = ""
    show(t, isFinal: true)
  }

  func clear() {
    lastPartial = ""
    if state != .hidden { fadeOut(0.2) }
  }

  func observe(muted nowMuted: Bool, speaking: Bool) {
    if nowMuted != muted {
      muted = nowMuted
      lastPartial = ""
      if muted, state != .hidden { fadeOut(0.12) }
    }
    if speaking != wasSpeaking {
      wasSpeaking = speaking
      guard speaking, state != .hidden else { return }
      if state == .final {
        let onScreen = Date().timeIntervalSince(finalAt)
        if onScreen >= 1.0 { fadeOut(0.2) } else { schedule(after: 1.0 - onScreen) { self.fadeOut(0.2) } }
      } else { fadeOut(0.2) }
    }
  }
}

let transcript = Transcript()
NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: panel, queue: .main) { _ in transcript.reposition() }

final class LineReader {
  var buffer = Data()
  var skipping = false
  let maxLine = 8 * 1024

  func feed(_ data: Data) {
    for byte in data {
      if byte == 10 {
        if !skipping, !buffer.isEmpty { handle(buffer) }
        buffer.removeAll(keepingCapacity: true)
        skipping = false
      } else if !skipping {
        buffer.append(byte)
        if buffer.count > maxLine { skipping = true; buffer.removeAll(keepingCapacity: true) }
      }
    }
  }

  func handle(_ line: Data) {
    guard let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any], let type = obj["type"] as? String else { return }
    let text = obj["text"] as? String ?? ""
    DispatchQueue.main.async {
      switch type {
      case "partial": transcript.partial(text)
      case "final": transcript.final(text)
      case "clear": transcript.clear()
      default: break
      }
    }
  }
}

if isatty(0) == 0 {
  let reader = LineReader()
  FileHandle.standardInput.readabilityHandler = { handle in
    let data = handle.availableData
    if data.isEmpty {
      handle.readabilityHandler = nil
      DispatchQueue.main.async { transcript.hideNow() }
      return
    }
    reader.feed(data)
  }
}

if demo && !CommandLine.arguments.contains("--no-script") {
  let long = "so I think we should move the retry into the upload function and add a short back-off, then make the tests wait for it instead of sleeping, and finally log how many tries it took"
  let script: [(Double, String, String)] = [
    (0.5, "partial", "so I think we"), (1.2, "partial", "so I think we should move the retry"),
    (1.9, "partial", "so I think we should move the retry into the upload function"),
    (2.8, "final", "So I think we should move the retry into the upload function."),
    (8.0, "partial", "can you also"), (8.7, "partial", "can you also check"), (9.4, "partial", "can you also check the"),
    (10.1, "partial", "can you also check the back-off"),
    // The same words again after the idle fade (about 12 s): the panel must stay hidden, not blink.
    (13.0, "partial", "can you also check the back-off"), (14.2, "partial", "can you also check the back-off"),
    (15.0, "partial", String(long.prefix(60))), (15.7, "partial", String(long.prefix(110))), (16.4, "partial", String(long.prefix(150))), (17.1, "partial", long),
    (18.0, "final", long + "."),
    (24.0, "clear", ""),
  ]
  func play() {
    for (at, type, text) in script {
      DispatchQueue.main.asyncAfter(deadline: .now() + at) {
        switch type {
        case "partial": transcript.partial(text)
        case "final": transcript.final(text)
        default: transcript.clear()
        }
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 27, execute: play)
  }
  play()
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

  transcript.observe(muted: muted, speaking: pill.talking)
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
