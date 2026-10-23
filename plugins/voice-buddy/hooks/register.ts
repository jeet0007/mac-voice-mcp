/**
 * voice-buddy: when you start typing during a Mac Voice turn, Claude stops talking and listening
 * at once. Without it, what you type waits until the turn ends (up to the 15-second wait for speech).
 *
 * How: at your first keystroke while this session's voice-mcp may be speaking or listening, this
 * writes {"at": <ms>} to voice-mcp's stop file (~/.cache/mac-voice-mcp/voice-mode/stop). voice-mcp
 * checks it ten times a second, stops, and tells Claude to wait for your typed message.
 *
 * "May be speaking or listening" is any of:
 * - a speak_and_listen call of this session is running;
 * - one with listen: false ("give me a minute") returned in the last 30 s, still playing in the background;
 * - voice-mcp's plugin hook marked this session as listening while Claude works ("Claude, …").
 *
 * Early-access API (Claude Code mods): if a Claude Code update breaks it, voice keeps working and
 * Esc still interrupts.
 */
import type { EngineInterface, Register } from 'claude-code'

/** voice-mcp's tool, under any server scope: plugin, user or project. */
const SPEAK = /(^|__)speak_and_listen$/
/** How long a spoken update (listen: false) may still be playing after its call returned. */
const UPDATE_PLAYS_MS = 30_000

let running = 0 // speak_and_listen calls of this session in progress
let updateUntil = 0 // a spoken update may be playing until then
let signalled = false // already told voice-mcp, since the last voice turn started
let reported = false // already said once that it couldn't

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
  if (running === 0 && now > updateUntil && !(await listeningHere($, dir))) return
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

export const register: Register = on => {
  on('tool.call', { tool: SPEAK }, async ($, e, next) => {
    running++
    signalled = false
    try {
      return await next(e)
    } finally {
      running--
      if ((e as { listen?: unknown }).listen === false) updateUntil = (await $.clock.now()) + UPDATE_PLAYS_MS
    }
  }).catch(($, e, next) => next(e)) // never in the way of the call itself

  // The first key that puts text in the box (not a cursor move), or a paste.
  on('prompt.edit', ($, e, next) => {
    if (e.inputText !== '') noticeTyping($)
    return next(e)
  })

  // Enter with text already in the box (typed before the turn began, or a queued prompt).
  on('prompt.submit', ($, e, next) => {
    noticeTyping($)
    return next(e)
  }).catch(($, e, next) => next(e)) // never in the way of the prompt
}
