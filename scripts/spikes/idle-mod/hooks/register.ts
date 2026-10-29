/**
 * Call mode Phase 0, routes A and B: while scripts/spikes/drive.mjs runs against this session, poll
 * its inbox and hand each utterance to Claude while it is idle.
 *
 *   A  $.session.send to this session's own id (the cross-session messaging socket).
 *   B  $.prompt.submit({ text, asUser: true }).
 *
 * Writes ack.json with what the engine answered, so a refused delivery shows up in the driver's log.
 */
import type { EngineInterface, Register, Timer } from 'claude-code'

const POLL_MS = 100
let timer: Timer | null = null
let lastId = ''

async function spikesDir($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME')
  return home ? `${home}/.cache/mac-voice-mcp/spikes` : undefined
}

async function readJson($: EngineInterface, file: string): Promise<any> {
  try {
    return JSON.parse(await $.fs.read(file))
  } catch {
    return null
  }
}

async function poll($: EngineInterface): Promise<void> {
  const dir = await spikesDir($)
  if (!dir) return
  const me = await $.session.id()
  const active = await readJson($, `${dir}/active.json`)
  if (active?.sessionId !== me || (active.route !== 'a' && active.route !== 'b')) return
  const u = await readJson($, `${dir}/inbox.json`)
  if (!u?.id || u.id === lastId || u.route !== active.route) return
  lastId = u.id
  const pickedAt = await $.clock.now()
  let answer: unknown
  try {
    answer =
      u.route === 'a'
        ? await $.session.send({ to: { sessionId: me }, text: u.text })
        : await $.prompt.submit({ text: u.text, asUser: true })
  } catch (err) {
    answer = { error: err instanceof Error ? err.message : String(err) }
  }
  await $.fs.write(`${dir}/ack.json`, JSON.stringify({ id: u.id, pickedAt, answeredAt: await $.clock.now(), answer }))
}

export const register: Register = on => {
  on('session.start', ($, e, next) => {
    timer?.cancel()
    timer = $.clock.every(POLL_MS, () => {
      poll($).catch(() => {})
    })
    return next(e)
  })
}
