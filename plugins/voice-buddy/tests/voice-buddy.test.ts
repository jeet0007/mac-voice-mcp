import { expect, mock, test } from 'claude-code/testing'

const SPEAK = 'mcp__plugin_mac-voice-mcp_voice-mcp__speak_and_listen'
const STOP = '/home/me/.cache/mac-voice-mcp/voice-mode/stop'
const LISTENING = '/home/me/.cache/mac-voice-mcp/voice-mode/listening.state'
const key = (inputText: string) => ({ origin: { kind: 'composer' as const }, text: '', cursor: 0, start: 0, end: 0, inputText })

/** The engine beneath the mod: env, clock, session id, files; what the mod writes is recorded. */
function engine(on: Parameters<Parameters<typeof test>[1]>[1], listeningSession?: string) {
  mock.env(on, { HOME: '/home/me' })
  const clock = mock.clock(on, { now: 1_000_000 })
  const writes: Array<{ path: string; text: string }> = []
  on('session.id', () => ({ value: 's1' }))
  on('prompt.edit', (_, e) => ({ text: e.text, cursor: e.cursor }))
  on('fs.write', (_, e) => {
    writes.push(e)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    if (e.path === LISTENING && listeningSession) return { value: JSON.stringify({ session: listeningSession, at: 1 }) }
    throw new Error('ENOENT')
  })
  return { clock, writes }
}

test('a keystroke during a voice turn tells voice-mcp to stop, once', async ($, on) => {
  const { clock, writes } = engine(on)
  on('tool.call', async () => {
    await $.prompt.edit(key('h')) // typed while voice-mcp speaks or listens
    await clock.settle()
    await $.prompt.edit(key('e'))
    await clock.settle()
    return { result: {} }
  })
  await $.tool.call({ tool: SPEAK, text_to_speak: 'Shall I start?' } as never)
  expect(writes.length).toBe(1)
  expect(writes[0]?.path).toBe(STOP)
  expect(JSON.parse(writes[0]?.text ?? '{}').at).toBe(1_000_000)
})

test('typing with no voice turn going on writes nothing, and neither does moving the cursor', async ($, on) => {
  const { clock, writes } = engine(on)
  on('tool.call', async () => {
    await $.prompt.edit(key('')) // a cursor move during the turn
    await clock.settle()
    return { result: {} }
  })
  await $.tool.call({ tool: SPEAK, text_to_speak: 'Hi' } as never)
  await $.prompt.edit(key('h')) // after the turn
  await clock.settle()
  expect(writes.length).toBe(0)
})

test('typing while voice-mcp listens as Claude works stops it, but only for this session', async ($, on) => {
  const here = engine(on, 's1')
  await $.prompt.edit(key('h'))
  await here.clock.settle()
  expect(here.writes.length).toBe(1)
})

test("another session's listening is left alone", async ($, on) => {
  const other = engine(on, 's2')
  await $.prompt.edit(key('h'))
  await other.clock.settle()
  expect(other.writes.length).toBe(0)
})

test('a spoken update still playing is stopped by typing, for 30 s after its call', async ($, on) => {
  const { clock, writes } = engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: SPEAK, text_to_speak: 'Give me a minute.', listen: false } as never)
  await clock.advance(31_000)
  await $.prompt.edit(key('h'))
  await clock.settle()
  expect(writes.length).toBe(0)
  await $.tool.call({ tool: SPEAK, text_to_speak: 'Still on it.', listen: false } as never)
  await clock.advance(5_000)
  await $.prompt.edit(key('h'))
  await clock.settle()
  expect(writes.length).toBe(1)
})
