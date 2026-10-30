/**
 * voice-buddy, a companion to Mac Voice in Claude Code:
 *
 * 1. The buddy: a soft animated blob above the prompt while voice is on in this window, its colour
 *    and motion showing what the voice turn is doing (speaking, listening, transcribing, waiting
 *    for the mic, or listening for "Claude, …" while Claude works). It reads voice-mcp's
 *    voice-mode/phase.json, and only while this window's voice turn runs.
 *
 * 2. Type to interrupt: when you start typing during a Mac Voice turn, Claude stops talking and
 *    listening at once. Without it, what you type waits until the turn ends (up to the 15-second
 *    wait for speech).
 *
 * How: at your first keystroke while this session's voice-mcp may be speaking or listening, this
 * writes {"at": <ms>} to voice-mcp's stop file (~/.cache/mac-voice-mcp/voice-mode/stop). voice-mcp
 * checks it ten times a second, stops, and tells Claude to wait for your typed message.
 *
 * "May be speaking or listening" is any of:
 * - a speak_and_listen call of this session is running;
 * - one with listen: false ("give me a minute") returned in the last 30 s, still playing in the background;
 * - voice-mcp's plugin hook marked this session as listening while Claude works ("Claude, …");
 * - this window is on a call (the call tool, action start).
 *
 * 3. On a call, while Claude is idle: what you say waits in voice-mcp's inbox, and nothing would
 *    read it until Claude's next tool call. This hands each utterance to Claude as a new message
 *    ($.prompt.submit as you), polling the inbox between turns. It tells Claude so right after the
 *    call starts, so Claude ends its turns normally instead of waiting in listen.
 *
 * Early-access API (Claude Code mods): if a Claude Code update breaks it, voice keeps working and
 * Esc still interrupts.
 */
import type { EngineInterface, Register, Timer } from 'claude-code'
import { blobCells, blobSvg, LOOKS, type Mood } from './blob.ts'

/** voice-mcp's tools, under any server scope: plugin, user or project. */
const SPEAK = /(^|__)speak_and_listen$/
const CALL = /(^|__)call$/
const SAY = /(^|__)say$/
/** How often, on a call with Claude idle, the inbox is checked. */
const INBOX_POLL_MS = 150
/** Added to the call start result: Claude reads it after the call rules. */
const IDLE_DELIVERY_NOTE =
  'Voice Buddy is on in this window: whatever the user says on the call while you are idle is handed to you ' +
  'as a new message from them. So end your turns normally and do not call listen to wait for them.'
/** How long a spoken update (listen: false) may still be playing after its call returned. */
const UPDATE_PLAYS_MS = 30_000

let running = 0 // speak_and_listen calls of this session in progress
let updateUntil = 0 // a spoken update may be playing until then
let signalled = false // already told voice-mcp, since the last voice turn started
let reported = false // already said once that it couldn't

// --- A call ---
let onCall = false // this window started a call (and hasn't seen it end)
let mainTurn = false // Claude's main loop is in a turn: its tool calls and the hook deliver the inbox then
let delivering = false // one $.prompt.submit at a time
let deliveryBroken = false // $.prompt.submit failed on this call: leave the inbox to listen, say and the hook
let inboxTimer: Timer | null = null

// --- The buddy ---
/** What the buddy shows now; null hides it. */
let mood: Mood | null = null
/** The terminal band the buddy is drawn in, for repainting it between redraws. */
let terminalBand: string | undefined
let timer: Timer | null = null
let ticks = 0
const TICK_MS = 80 // about 12 frames a second in the terminal
const REFRESH_TICKS = 3 // check what the voice turn is doing about 4 times a second
const COLUMNS = 10
const ROWS = 5
const LABELS: Record<Mood, string> = {
  speaking: 'Speaking',
  listening: 'Listening',
  transcribing: 'Got it, transcribing',
  waiting: 'Waiting for another voice session',
  standby: 'Listening for "Claude, …"',
}
const PHASES: Record<string, Mood> = { speaking: 'speaking', listening: 'listening', transcribing: 'transcribing', waiting: 'waiting' }

/** voice-mcp's cache folder, resolved the way voice-mcp and its hook resolve it. */
async function voiceModeDir($: EngineInterface): Promise<string | undefined> {
  const dir = await $.env.get('VOICE_MCP_CACHE_DIR')
  if (dir) return `${dir}/voice-mode`
  const xdg = await $.env.get('XDG_CACHE_HOME')
  if (xdg) return `${xdg}/mac-voice-mcp/voice-mode`
  const home = await $.env.get('HOME')
  return home ? `${home}/.cache/mac-voice-mcp/voice-mode` : undefined
}

/** Is voice-mcp listening while Claude works, for this session? */
async function listeningHere($: EngineInterface, dir: string): Promise<boolean> {
  try {
    const mark = JSON.parse(await $.fs.read(`${dir}/listening.state`)) as { session?: unknown }
    return mark.session === (await $.session.id())
  } catch {
    return false
  }
}

async function userTyped($: EngineInterface): Promise<void> {
  if (signalled) return
  const now = await $.clock.now()
  const dir = await voiceModeDir($)
  if (!dir) throw new Error('no HOME to find voice-mcp in')
  if (running === 0 && now > updateUntil && !onCall && !(await listeningHere($, dir))) return
  signalled = true
  await $.fs.write(`${dir}/stop`, JSON.stringify({ at: now }))
}

/**
 * Never let this get in the way of typing: a failure only means voice-mcp keeps going until the
 * turn ends. Say why, once. (Success needs no message: the voice going quiet is the message.)
 */
function noticeTyping($: EngineInterface): void {
  userTyped($).catch((err: unknown) => {
    signalled = false
    if (reported) return
    reported = true
    $.ui.toast(`voice-buddy couldn't stop the voice: ${err instanceof Error ? err.message : String(err)}`)
  })
}

/** What this window's voice is doing now, or null when it's off here. */
async function currentMood($: EngineInterface): Promise<Mood | null> {
  const dir = await voiceModeDir($)
  if (!dir) return null
  if (running > 0 || (await $.clock.now()) <= updateUntil) {
    try {
      const { phase } = JSON.parse(await $.fs.read(`${dir}/phase.json`)) as { phase?: string }
      const known = phase ? PHASES[phase] : undefined
      if (known) return known
    } catch {
      /* no phase file: between phases, or an older voice-mcp */
    }
    if (running > 0) return 'speaking'
  }
  return (await listeningHere($, dir)) ? 'standby' : null
}

/** Read the inbox entries that still have words in them, oldest first. */
async function readInbox($: EngineInterface, inbox: string): Promise<Array<{ file: string; text: string }>> {
  let names: string[]
  try {
    names = (await $.fs.list(inbox)).filter((e) => e.kind === 'file' && e.name.endsWith('.json') && e.size > 0).map((e) => e.name)
  } catch {
    return [] // no inbox yet
  }
  const out: Array<{ file: string; text: string }> = []
  for (const name of names.sort()) {
    const file = `${inbox}/${name}`
    try {
      const { text } = JSON.parse(await $.fs.read(file)) as { text?: unknown }
      if (typeof text === 'string') out.push({ file, text })
    } catch {
      /* taken by voice-mcp meanwhile, or not ours */
    }
  }
  return out
}

/** On a call with Claude idle: hand what the user said to Claude as their next message. */
async function deliverInbox($: EngineInterface): Promise<void> {
  if (!onCall || mainTurn || delivering || deliveryBroken) return
  const dir = await voiceModeDir($)
  if (!dir) return
  if (!(await $.fs.exists(`${dir}/call.json`))) {
    onCall = false
    inboxTimer?.cancel()
    inboxTimer = null
    return
  }
  const entries = await readInbox($, `${dir}/inbox`)
  if (!entries.length) return
  delivering = true
  try {
    // Blanked before submitting, so the hook can't hand the same words over again mid-turn.
    // voice-mcp removes the blank files.
    for (const e of entries) await $.fs.write(e.file, '')
    try {
      await $.prompt.submit({ text: entries.map((e) => e.text).join('\n'), asUser: true })
    } catch (err) {
      for (const e of entries) await $.fs.write(e.file, JSON.stringify({ text: e.text, at: await $.clock.now() }))
      deliveryBroken = true
      $.ui.toast(`voice-buddy can't pass on what you say while Claude is idle (${err instanceof Error ? err.message : String(err)}); Claude hears it at its next tool call or listen`)
    }
  } finally {
    delivering = false
  }
}

/** After a reload, which forgets the call start it saw: pick the call back up if it's this window's. */
async function resumeCall($: EngineInterface): Promise<void> {
  const dir = await voiceModeDir($)
  if (!dir) return
  try {
    const call = JSON.parse(await $.fs.read(`${dir}/call.json`)) as { session?: unknown }
    if (call.session !== (await $.session.id())) return
  } catch {
    return // no call
  }
  onCall = true
  deliveryBroken = false
  watchInbox($)
}

function watchInbox($: EngineInterface): void {
  if (inboxTimer) return
  inboxTimer = $.clock.every(INBOX_POLL_MS, () => {
    deliverInbox($).catch(() => {})
  })
}

/** Keep the buddy moving (terminal) and in step with the voice turn, until voice is off here. */
function animate($: EngineInterface): void {
  if (timer) return
  ticks = 0
  timer = $.clock.every(TICK_MS, () => {
    tick($).catch(() => {})
  })
}

async function tick($: EngineInterface): Promise<void> {
  ticks++
  if (ticks % REFRESH_TICKS === 1) {
    const now = await currentMood($)
    if (now !== mood) {
      mood = now
      $.ui.invalidate('ui.render')
    }
    if (mood === null) {
      timer?.cancel()
      timer = null
      return
    }
  }
  if (mood && terminalBand) {
    const p = ((ticks * TICK_MS) % LOOKS[mood].loopMs) / LOOKS[mood].loopMs
    await $.ui.blit({ requestId: terminalBand, key: 'buddy', cells: blobCells(mood, p, COLUMNS, ROWS) })
  }
}

export const register: Register = on => {
  on('tool.call', { tool: SPEAK }, async ($, e, next) => {
    running++
    signalled = false
    animate($)
    try {
      return await next(e)
    } finally {
      running--
      if ((e as { listen?: unknown }).listen === false) updateUntil = (await $.clock.now()) + UPDATE_PLAYS_MS
    }
  }).catch(($, e, next) => next(e)) // never in the way of the call itself

  on('tool.call', { tool: CALL }, async ($, e, next) => {
    signalled = false
    const r = await next(e)
    const action = (e as { action?: unknown }).action
    if (action === 'end') onCall = false
    if (action === 'start' && r.deny === undefined && !r.isError) {
      onCall = true
      deliveryBroken = false
      watchInbox($)
      return { ...r, context: [...(r.context ?? []), IDLE_DELIVERY_NOTE] }
    }
    return r
  }).catch(($, e, next) => next(e))

  // Each say is new speech that typing may interrupt.
  on('tool.call', { tool: SAY }, ($, e, next) => {
    signalled = false
    return next(e)
  }).catch(($, e, next) => next(e))

  // Only the main loop's turns count: a subagent's run inside one doesn't change who reads the inbox.
  on('turn.start', ($, e, next) => {
    if (!e.agentId) mainTurn = true
    return next(e)
  })
  on('turn.complete', ($, e, next) => {
    if (!e.agentId) mainTurn = false
    return next(e)
  })

  // The first key that puts text in the box (not a cursor move), or a paste.
  on('prompt.edit', ($, e, next) => {
    if (e.inputText !== '') noticeTyping($)
    return next(e)
  })

  // Enter with text already in the box (typed before the turn began, or a queued prompt).
  on('prompt.submit', ($, e, next) => {
    // A prompt a plugin submitted (ours hands over what the user said on a call) isn't the user typing.
    if (e.origin.kind !== 'plugin') noticeTyping($)
    return next(e)
  }).catch(($, e, next) => next(e)) // never in the way of the prompt

  // A new window, or a reload, while voice-mcp listens for "Claude, …" here: show the buddy.
  // After a reload mid-call, carry on delivering what the user says.
  on('session.start', async ($, e, next) => {
    animate($)
    await resumeCall($).catch(() => {})
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.props.hasSurvey || mood === null) return next(e)
    const shown = mood
    const hint = shown === 'speaking' || shown === 'listening' ? ' · type to interrupt' : ''
    if (e.surface === 'terminal') {
      terminalBand = e.requestId
      const { Box, Raster, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" alignItems="center">
          <Raster key="buddy" columns={COLUMNS} rows={ROWS} cells={blobCells(shown, 0, COLUMNS, ROWS)} />
          <Text> {LABELS[shown]}</Text>
          <Text dimColor>{hint}</Text>
        </Box>
      )
    }
    const { Box, Svg, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="center">
        <Svg source={blobSvg(shown)} alt={`Voice: ${LABELS[shown]}`} width={28} height={28} isInteractive />
        <Text> {LABELS[shown]}</Text>
        <Text dimColor>{hint}</Text>
      </Box>
    )
  })
}
