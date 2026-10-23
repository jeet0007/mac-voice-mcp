import { expect, mock, test } from 'claude-code/testing'
import { blobCells, blobPath, blobSvg, LOOKS } from '../hooks/blob.ts'

const SPEAK = 'mcp__plugin_mac-voice-mcp_voice-mcp__speak_and_listen'
const STOP = '/home/me/.cache/mac-voice-mcp/voice-mode/stop'
const LISTENING = '/home/me/.cache/mac-voice-mcp/voice-mode/listening.state'
const PHASE = '/home/me/.cache/mac-voice-mcp/voice-mode/phase.json'
const key = (inputText: string) => ({ origin: { kind: 'composer' as const }, text: '', cursor: 0, start: 0, end: 0, inputText })

/** The engine beneath the mod: env, clock, session id, files; what the mod writes is recorded. */
function engine(on: Parameters<Parameters<typeof test>[1]>[1], listeningSession?: string, phase?: string) {
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
    if (e.path === PHASE && phase) return { value: JSON.stringify({ phase, at: 1 }) }
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

// --- The buddy -------------------------------------------------------------------------------

const BAND = {
  plugin: 'voice-buddy',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('during a voice turn the buddy shows what it is doing, on every surface', async ($, on) => {
  const { clock } = engine(on, undefined, 'listening')
  on('ui.render', ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('ui.blit', () => ({ value: {} }))
  on('tool.call', async () => {
    await clock.advance(100) // the buddy checks what the turn is doing
    const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await terminal.find({ type: 'Text', text: /Listening/ })).toBeDefined()
    expect(await terminal.find({ type: 'Raster' })).toBeDefined()
    await terminal.unmount()
    for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Svg' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /type to interrupt/ })).toBeDefined()
      await ui.unmount()
    }
    return { result: {} }
  })
  await $.tool.call({ tool: SPEAK, text_to_speak: 'Shall I start?' } as never)
})

test('with voice off in this window, the band is left to others', async ($, on) => {
  const { clock } = engine(on, 's2', 'speaking') // another window's turn
  on('ui.render', ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(500)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('while voice-mcp listens for "Claude, …" here, the buddy says so', async ($, on) => {
  const { clock } = engine(on, 's1')
  on('ui.render', ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(100)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Listening for "Claude, …"/ })).toBeDefined()
  await ui.unmount()
})

test('the blob loops seamlessly, and its frames fit the Raster', async () => {
  for (const look of Object.values(LOOKS)) expect(blobPath(1, look, 20, 20, 14)).toBe(blobPath(0, look, 20, 20, 14))
  const cells = blobCells('speaking', 0.3, 8, 4)
  expect(cells.length).toBe(Math.ceil((8 * 4 * 12) / 3) * 4) // base64 of 8x4 cells, 12 bytes each
  expect(blobSvg('listening')).toContain('<animate attributeName="d"')
})
