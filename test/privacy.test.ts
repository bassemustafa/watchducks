import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

const USAGE = { model: 'claude-sonnet-5-5', input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const RESULT_JSON =
  '{"schema":"delegate-relay.result.v1","tool":"opencode","status":"completed","totalCostUsd":0.01,"finalMessage":"SENTINEL-FINAL"}'
const START = { cwd: '/work', surface: null, isInteractive: true }

// The step result the test answers beneath the plugin: its answer and tool inputs carry sentinels.
const STEP_RESULT = {
  turnId: 't1',
  index: 0,
  answer: 'SENTINEL-STEP-ANSWER',
  toolUses: [{ name: 'Bash', input: { command: 'SENTINEL-STEP-INPUT' } }],
  stopReason: 'end_turn',
  usage: USAGE,
} as never

// A pane of the plugin, mounted as the engine draws it for a surface and a width.
function pane($: Engine, surface: 'terminal' | 'desktop', columns: number) {
  return $.ui.mount({
    plugin: 'watchducks',
    surface,
    component: 'Pane',
    requestId: 'flock',
    props: { title: 'The Flock', isFocused: false, bodyColumns: columns, placement: 'dock' } as never,
    viewport: { columns: columns + 4, rows: 40, isFullscreen: true },
  })
}

function band($: Engine) {
  return $.ui.mount({
    plugin: 'watchducks',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 60 } as never,
    viewport: { columns: 64, rows: 40, isFullscreen: true },
  })
}

async function drawn(m: { drawn: () => Promise<unknown> }): Promise<string> {
  return JSON.stringify(await m.drawn())
}

// Everything the plugin writes or shows, as the hooks beneath it see it: serialised at the moment of the write.
type Seen = { state: string[]; store: string[]; shown: string[]; storeKeys: () => string[] }

function observe(on: On): Seen {
  const seen: Seen = { state: [], store: [], shown: [], storeKeys: () => [] }
  const entries = new Map<string, unknown>()
  seen.storeKeys = () => [...entries.keys()]
  on('state.set', { plugin: 'watchducks', key: 'ledger' }, async ($, e, next) => {
    seen.state.push(JSON.stringify(e.value))
    return next(e)
  })
  on('state.set', { plugin: 'watchducks', key: 'ui' }, async ($, e, next) => {
    seen.state.push(JSON.stringify(e.value))
    return next(e)
  })
  on('store.keys', async () => ({ value: [...entries.keys()] }))
  on('store.get', async ($, e) => ({ value: entries.get(e.key) }))
  on('store.set', async ($, e) => {
    seen.store.push(JSON.stringify(e.value))
    entries.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', async ($, e) => {
    entries.delete(e.key)
    return { value: undefined }
  })
  on('ui.toast', async ($, e) => {
    seen.shown.push(e.text)
    return { value: undefined }
  })
  on('ui.status', async ($, e) => {
    seen.shown.push(e.text ?? '')
    return { value: undefined }
  })
  return seen
}

test('privacy canary: planted sentinels never reach state, store, toasts, status or trees', { options: { notify: 'on' } }, async ($, on) => {
  // register every test hook before the first call to `$`: the kit refuses later registrations
  const seen = observe(on)
  on('command.register', async () => ({ value: { command: 'flock' } }))
  on('tool.register', async () => ({ value: { tool: 'mcp__watchducks__x' } }))
  on('session.id', async () => ({ value: 'S1' }))
  on('session.root', async () => ({ value: '/work' }))
  on('session.surfaces', async () => ({ value: ['terminal'] }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.end', async () => ({ sessionId: 'S1' }))
  on('ui.panes', async () => ({ value: [{ id: 'flock', title: 'The Flock', isShown: true, isFocused: false, isPlaced: false }] }))
  // the engine draws nothing in the band or elsewhere when the plugin hands it on
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e) as unknown as { Text: (props: { children: string }) => never }
    return Text({ children: '' })
  })
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'c1' }))
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'SENTINEL-CHUNK' } as never
    return STEP_RESULT
  })
  on('turn.complete', async () => ({ text: 'SENTINEL-ANSWER' }))
  on('classic.Stop', async () => ({}))
  on('classic.SubagentStop', async () => ({}))
  on('tool.call', { tool: 'Bash' }, async ($, e) =>
    ({
      result:
        e.tool_use_id === 'p4'
          ? { backgroundTaskId: 't9', stdout: 'SENTINEL-STDOUT', stderr: 'SENTINEL-STDERR' }
          : { stdout: 'SENTINEL-STDOUT', stderr: 'SENTINEL-STDERR' },
    }) as never,
  )
  on('tool.call', { tool: 'ReportFindings' }, async () => ({ result: { count: 2, findings: [{ summary: 'SENTINEL-FINDINGS' }] } }) as never)
  on('tool.call', { tool: 'Edit' }, async () => ({ result: {} }) as never)
  on('fs.stat', async ($, e) => ({
    value: {
      kind: 'file' as const,
      size: RESULT_JSON.length,
      mtimeMs: Date.now(),
      isLink: false,
      realPath: e.path.endsWith('result.json') ? '/tmp/p/result.json' : e.path,
    },
  }))
  on('fs.read', async () => ({ value: RESULT_JSON }))
  mock.env(on, {})
  const clock = mock.clock(on)

  await $.session.start(START)
  await $.agent.spawn({ subagentType: 'Explore', prompt: 'SENTINEL-PROMPT', description: 'SENTINEL-DESCRIPTION' } as never)
  for await (const _ of $.turn.step({ agentId: 'c1', turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'high' } as never)) {
    /* chunks are never read */
  }
  await $.turn.complete({
    agentId: 'c1',
    turnId: 't1',
    reason: 'answer',
    answer: 'SENTINEL-ANSWER',
    refusal: 'SENTINEL-ANSWER',
    durationMs: 1,
    isAborted: false,
  } as never)
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'SENTINEL-MESSAGE' })
  await $.classic.SubagentStop({
    stop_hook_active: false,
    agent_id: 'c1',
    agent_transcript_path: '',
    agent_type: 'Explore',
    last_assistant_message: 'SENTINEL-SUBAGENT-MESSAGE',
  })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'p1', command: 'claude -p "SENTINEL-CMD" --model claude-haiku-5-5' } as never)
  await $.tool.call({ tool: 'ReportFindings', agentId: 'c1', tool_use_id: 'p2', findings: [{ summary: 'SENTINEL-FINDINGS' }] } as never)
  await $.tool.call({ tool: 'Edit', agentId: 'c1', tool_use_id: 'p3', file_path: '/work/a.txt', old_string: 'SENTINEL-OLD', new_string: 'SENTINEL-NEW' } as never)
  await $.tool.call({
    tool: 'Bash',
    tool_use_id: 'p4',
    run_in_background: true,
    command: 'node x/opencode-delegate/scripts/relay.mjs --lane quick --out-dir /tmp/p',
  } as never)
  await clock.advance(3000)
  // the history record: the only thing the mod writes to the store
  await $.session.end({ reason: 'exit' } as never)

  // the scenario reached the places the canary guards
  expect(seen.state.some(s => s.includes('"bash:p4"'))).toBe(true)
  expect(seen.state.some(s => s.includes('"c1"'))).toBe(true)
  expect(seen.store.length).toBeGreaterThan(0)
  expect(seen.storeKeys()).toEqual(['history/v1/S1'])
  expect(seen.shown.length).toBeGreaterThan(0)

  const trees: string[] = []
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await pane($, surface, 60)
    trees.push(await drawn(ui)) // field view
    await ui.press({ key: 'c1' })
    trees.push(await drawn(ui)) // dossier of the subagent
    await ui.press({ key: 'back' })
    await ui.press({ key: 'bash:p4' })
    trees.push(await drawn(ui)) // dossier of the relay run
    await ui.press({ key: 'back' })
    await ui.press({ key: 'station' })
    await ui.press({ key: 'span' })
    trees.push(await drawn(ui)) // station board over the stored history
    await ui.press({ key: 'span' })
    await ui.press({ key: 'field' })
    await ui.unmount()
  }
  const bandTree = await drawn(await band($))
  trees.push(bandTree)
  expect(trees[0]).not.toContain('No operatives yet')
  expect(bandTree).toContain('FLOCK')

  const dump = JSON.stringify([seen.state, seen.store, seen.shown, trees])
  expect(dump).not.toContain('SENTINEL')
})

test('privacy: an agent adopted from $.agent.list() never leaks its listed description', { options: { notify: 'on' } }, async ($, on) => {
  const seen = observe(on)
  on('command.register', async () => ({ value: { command: 'flock' } }))
  on('tool.register', async () => ({ value: { tool: 'mcp__watchducks__x' } }))
  on('session.id', async () => ({ value: 'S1' }))
  on('session.root', async () => ({ value: '/work' }))
  on('session.surfaces', async () => ({ value: ['terminal'] }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.end', async () => ({ sessionId: 'S1' }))
  on('ui.panes', async () => ({ value: [{ id: 'flock', title: 'The Flock', isShown: true, isFocused: false, isPlaced: false }] }))
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e) as unknown as { Text: (props: { children: string }) => never }
    return Text({ children: '' })
  })
  // a forked skill: listed by the engine, never spawned through agent.spawn
  on('agent.list', async () => ({
    value: [{ id: 'f1', description: 'SENTINEL-LIST-DESCRIPTION', type: 'skill', status: 'running', parentId: 'p1' }] as never,
  }))
  on('turn.step', async function* () {
    return STEP_RESULT
  })
  on('turn.complete', async () => ({ text: '' }))
  mock.env(on, {})
  const clock = mock.clock(on)

  await $.session.start(START)
  for await (const _ of $.turn.step({ agentId: 'f1', turnId: 't1', index: 0, model: 'claude-sonnet-5-5' } as never)) {
    /* chunks are never read */
  }
  await $.turn.complete({ agentId: 'f1', turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false } as never)
  await clock.advance(3000) // the watch tick sees the run done: stamp, toast and a history save
  await $.session.end({ reason: 'exit' } as never)

  // the step was adopted into a run (not left to engine overhead), and the canary's places were reached
  expect(seen.state.some(s => s.includes('"f1"') && s.includes('"skill"'))).toBe(true)
  expect(seen.store.length).toBeGreaterThan(0)
  expect(seen.shown.length).toBeGreaterThan(0)

  const trees: string[] = []
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await pane($, surface, 60)
    trees.push(await drawn(ui)) // field view
    await ui.press({ key: 'f1' })
    trees.push(await drawn(ui)) // dossier of the adopted agent
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
  trees.push(await drawn(await band($)))

  const dump = JSON.stringify([seen.state, seen.store, seen.shown, trees])
  expect(dump).not.toContain('SENTINEL-LIST-DESCRIPTION')
  expect(dump).not.toContain('SENTINEL')
})
