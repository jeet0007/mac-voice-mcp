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

// --- A call: what the user says while Claude is idle becomes their next message --------------

const CALL = 'mcp__plugin_mac-voice-mcp_voice-mcp__call'
const DIR = '/home/me/.cache/mac-voice-mcp/voice-mode'
const INBOX = `${DIR}/inbox`

/** The engine on a call: call.json exists, the inbox holds `entries`, and submits and toasts are recorded. */
function callEngine(on: Parameters<Parameters<typeof test>[1]>[1], entries: Record<string, string>, submit: () => unknown = () => ({ text: '' })) {
  mock.env(on, { HOME: '/home/me' })
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = {}
  for (const [name, text] of Object.entries(entries)) files[`${INBOX}/${name}`] = JSON.stringify({ text, at: 1 })
  const submitted: string[] = []
  const toasts: string[] = []
  on('session.id', () => ({ value: 's1' }))
  on('tool.call', () => ({ result: {} }))
  on('prompt.edit', (_, e) => ({ text: e.text, cursor: e.cursor }))
  on('fs.exists', (_, e) => ({ value: e.path === `${DIR}/call.json` }))
  on('fs.list', (_, e) => {
    if (e.path !== INBOX) throw new Error('ENOENT')
    const value = Object.keys(files).map((f) => ({ name: f.slice(INBOX.length + 1), kind: 'file' as const, size: files[f]!.length, mtimeMs: 1, isLink: false }))
    return { value }
  })
  on('fs.read', (_, e) => {
    if (e.path in files) return { value: files[e.path]! }
    throw new Error('ENOENT')
  })
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    const origin = e.origin as { kind?: unknown; asUser?: unknown }
    submitted.push(JSON.stringify({ text: e.text, origin: origin.kind, asUser: origin.asUser }))
    return submit() as never
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { clock, files, submitted, toasts }
}

test('call start tells Claude that Voice Buddy delivers what the user says while it is idle', async ($, on) => {
  callEngine(on, {})
  const r = await $.tool.call({ tool: CALL, action: 'start' } as never)
  expect(r.context?.join(' ')).toMatch(/whatever the user says on the call while you are idle is handed to you as a new message/)
  const again = await $.tool.call({ tool: CALL, action: 'end' } as never)
  expect(again.context).toBeUndefined()
})

test('on a call with Claude idle, an inbox entry is submitted as the user and its file blanked', async ($, on) => {
  const { clock, files, submitted } = callEngine(on, { '1000-a.json': 'use the other branch' })
  await $.tool.call({ tool: CALL, action: 'start' } as never)
  await clock.advance(200)
  expect(submitted).toEqual([JSON.stringify({ text: 'use the other branch', origin: 'plugin', asUser: true })])
  expect(files[`${INBOX}/1000-a.json`]).toBe('')
  await clock.advance(200)
  expect(submitted.length).toBe(1)
  // Handing over the user's words is not the user typing: it must not stop Claude's voice.
  expect(files[`${DIR}/stop`]).toBeUndefined()
})

test('while a main turn runs nothing is submitted; after it, the inbox is delivered oldest first', async ($, on) => {
  const { clock, submitted } = callEngine(on, { '1001-b.json': 'and run the tests', '1000-a.json': 'use the other branch' })
  await $.tool.call({ tool: CALL, action: 'start' } as never)
  await $.turn.start({ text: 'hi', turnId: 't1' } as never)
  await clock.advance(400)
  expect(submitted).toEqual([])
  await $.turn.start({ text: '', turnId: 'a1', agentId: 'sub' } as never) // a subagent's turn changes nothing
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.advance(200)
  expect(submitted).toEqual([JSON.stringify({ text: 'use the other branch\nand run the tests', origin: 'plugin', asUser: true })])
})

test('if submitting fails, the entries are put back, a toast says so once, and idle delivery stops for this call', async ($, on) => {
  const { clock, files, submitted, toasts } = callEngine(on, { '1000-a.json': 'use the other branch' }, () => {
    throw new Error('no prompt here')
  })
  await $.tool.call({ tool: CALL, action: 'start' } as never)
  await clock.advance(200)
  expect(submitted.length).toBe(1)
  expect(JSON.parse(files[`${INBOX}/1000-a.json`]!).text).toBe('use the other branch')
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/^voice-buddy can't pass on what you say while Claude is idle \(.*\); Claude hears it at its next tool call or listen$/)
  await clock.advance(600)
  expect(submitted.length).toBe(1)
  expect(toasts.length).toBe(1)
})

test("after a reload mid-call, this window's call is picked up again from call.json; another window's isn't", async ($, on) => {
  const { clock, files, submitted } = callEngine(on, { '1000-a.json': 'are you still there' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  files[`${DIR}/call.json`] = JSON.stringify({ pid: 1, session: 's2' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(400)
  expect(submitted).toEqual([])
  files[`${DIR}/call.json`] = JSON.stringify({ pid: 1, session: 's1' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(400)
  expect(submitted).toEqual([JSON.stringify({ text: 'are you still there', origin: 'plugin', asUser: true })])
})

test("typing during a call doesn't write the stop file (a typo shouldn't cut Claude off)", async ($, on) => {
  const { clock, files } = callEngine(on, {})
  await $.tool.call({ tool: CALL, action: 'start' } as never)
  await $.prompt.edit(key('h'))
  await clock.settle()
  expect(files[`${DIR}/stop`]).toBeUndefined()
})

test('the blob loops seamlessly, and its frames fit the Raster', async () => {
  for (const look of Object.values(LOOKS)) expect(blobPath(1, look, 20, 20, 14)).toBe(blobPath(0, look, 20, 20, 14))
  const cells = blobCells('speaking', 0.3, 8, 4)
  expect(cells.length).toBe(Math.ceil((8 * 4 * 12) / 3) * 4) // base64 of 8x4 cells, 12 bytes each
  expect(blobSvg('listening')).toContain('<animate attributeName="d"')
})
