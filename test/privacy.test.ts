import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

import type { Ledger } from '../types'
import { fingerprint } from '../src/collect/relay'

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

function withoutFolders(ledger: Ledger): Ledger {
  const runs: Ledger['runs'] = {}
  for (const [id, run] of Object.entries(ledger.runs)) runs[id] = { ...run, workdir: undefined, outDir: undefined }
  return { ...ledger, runs }
}

function observe(on: On, onLedger?: (ledger: Ledger) => void): Seen {
  const seen: Seen = { state: [], store: [], shown: [], storeKeys: () => [] }
  const entries = new Map<string, unknown>()
  seen.storeKeys = () => [...entries.keys()]
  on('state.set', { plugin: 'watchducks', key: 'ledger' }, async ($, e, next) => {
    // the one exemption (spec §7): `Run.workdir` and `Run.outDir` live in the in-memory ledger only; nothing else is dropped
    if (onLedger) onLedger(withoutFolders(e.value as Ledger))
    seen.state.push(JSON.stringify(onLedger ? withoutFolders(e.value as Ledger) : e.value))
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

test('privacy canary: planted sentinels never reach state, store, toasts, status or trees', { options: { notify: 'on', priceUpdates: 'off' } }, async ($, on) => {
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
    command: 'node x/opencode-handoff/scripts/relay.mjs --lane quick --out-dir /tmp/p',
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

// ---- v0.2 canaries: opencode stats, environment, Claude child reports (written and read)

const BAD_ID = 'SENTINEL not an id!'
const PARENT_ID = 'parent-session-id'
const SONNET = 'claude-sonnet-5-5'
const CLAUDE_P = `claude -p --model ${SONNET} "x"`
const SOL_RUN = 'opencode run -m openai/gpt-6.1-sol "x"'
const OWN_DIR = `/tmp/watchducks-children/${fingerprint('S1')}`

type Sinks = Seen & { writes: string[]; runs: string[]; ledger: () => Ledger }
type Files = Map<string, { text: string; mtimeMs: number }>

/**
 * Everything the plugin can write or show, plus what it hands to `$.fs.write` and `$.process.run`, serialised at the
 * moment of the call. `stats` answers `opencode stats` in order (the last repeats); `files` is the folder the plugin reads.
 */
function sinksOf(on: On, env: (name: string) => string | undefined, stats: readonly { stdout: string; stderr: string }[] = [], files: Files = new Map()): Sinks {
  let latest = { runs: {} } as unknown as Ledger
  const seen = observe(on, ledger => {
    latest = ledger
  })
  const sinks: Sinks = { ...seen, writes: [], runs: [], ledger: () => latest }
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
  on('agent.spawn', async () => ({ model: SONNET, agentId: 'c1' }))
  on('turn.step', async function* () {
    return STEP_RESULT
  })
  on('classic.Stop', async () => ({}))
  on('tool.call', { tool: 'Bash' }, async ($, e) =>
    ({ result: { backgroundTaskId: 't-' + e.tool_use_id, stdout: 'SENTINEL-STDOUT', stderr: 'SENTINEL-STDERR' } }) as never,
  )
  on('env.get', async ($, e) => ({ value: env(e.name) }))
  on('fs.write', async ($, e) => {
    sinks.writes.push(`${e.path}\n${e.text}`)
    return { value: undefined }
  })
  on('process.run', async ($, e) => {
    sinks.runs.push(JSON.stringify([e.argv, e.init?.cwd, e.init?.env, e.init?.stdin]))
    const reply = stats[Math.min(sinks.runs.length - 1, stats.length - 1)] ?? { stdout: '', stderr: '' }
    return { value: { exitCode: 0, stdout: reply.stdout, stderr: reply.stderr, isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('fs.stat', async ($, e) => {
    const f = files.get(e.path)
    if (f) return { value: { kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false, realPath: e.path } }
    if (e.path.endsWith('result.json')) return { value: { kind: 'file' as const, size: RESULT_JSON.length, mtimeMs: Date.now(), isLink: false, realPath: e.path } }
    const isDir = e.path === '/tmp' || [...files.keys()].some(k => k.startsWith(e.path + '/'))
    return { value: { kind: isDir ? ('dir' as const) : ('other' as const), size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }
  })
  on('fs.list', async ($, e) => ({
    value: [...files]
      .filter(([path]) => path.slice(0, path.lastIndexOf('/')) === e.path)
      .map(([path, f]) => ({ name: path.slice(path.lastIndexOf('/') + 1), kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })),
  }))
  on('fs.read', async ($, e) => ({ value: files.get(e.path)?.text ?? RESULT_JSON }))
  return sinks
}

/** The panes of both surfaces and the band, drawn as they stand: the field view and the dossier of each run key. */
async function treesOf($: Engine, keys: readonly string[]): Promise<string[]> {
  const trees: string[] = []
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await pane($, surface, 60)
    trees.push(await drawn(ui))
    for (const key of keys) {
      await ui.press({ key })
      trees.push(await drawn(ui))
      await ui.press({ key: 'back' })
    }
    await ui.unmount()
  }
  trees.push(await drawn(await band($)))
  return trees
}

const everything = (s: Sinks, trees: readonly string[]): string => JSON.stringify([s.state, s.store, s.shown, s.writes, s.runs, trees])

const stopNow = { stop_hook_active: false, background_tasks: [] } as never

test('privacy canary: opencode stats stdout and stderr extras never leave the allow-list', { options: { notify: 'on', opencodeStats: 'on' } }, async ($, on) => {
  const tokens = (n: number, extra: Record<string, unknown>) => ({ input: n * 100, output: n * 10, reasoning: n, cache: { read: n * 1000, write: 0 }, ...extra })
  const stats = (sessions: number, n: number): string =>
    JSON.stringify({
      sessions,
      title: 'SENTINEL-TOP-TITLE',
      text: 'SENTINEL-TOP-TEXT',
      tokens: tokens(n, { note: 'SENTINEL-TOKENS-NOTE', title: 'SENTINEL-TOKENS-TITLE' }),
      cost: n / 10,
      models: [
        {
          model: { id: 'gpt-6.1-sol', providerID: 'openai', name: 'SENTINEL-MODEL-NAME' },
          title: 'SENTINEL-ENTRY-TITLE',
          text: 'SENTINEL-ENTRY-TEXT',
          tokens: tokens(n, { note: 'SENTINEL-ENTRY-TOKENS' }),
          cost: n / 10,
        },
        { model: { id: BAD_ID, providerID: 'openai' }, tokens: tokens(n, {}), cost: n / 10 },
        { model: { id: 'ok-model', providerID: BAD_ID }, tokens: tokens(n, {}), cost: n / 10 },
      ],
    })
  const s = sinksOf(on, () => undefined, [
    { stdout: stats(1, 1), stderr: 'SENTINEL-STDERR-A' },
    { stdout: stats(2, 3), stderr: 'SENTINEL-STDERR-B' },
    { stdout: stats(2, 5), stderr: 'SENTINEL-STDERR-C' },
  ])
  const clock = mock.clock(on)

  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', run_in_background: true, command: `cd /proj && ${SOL_RUN}` } as never)
  await clock.advance(500) // the baseline
  await clock.advance(10_000) // the live numbers
  await $.classic.Stop(stopNow)
  await clock.advance(10_000) // the final snapshot
  await $.session.end({ reason: 'exit' } as never)

  // numbers flowed, and the places the canary guards were reached
  expect(s.runs.length).toBeGreaterThanOrEqual(2)
  expect(s.ledger().runs['bash:u1']!.usage!.uncached).toBeGreaterThan(0)
  expect(s.store.length).toBeGreaterThan(0)
  expect(s.shown.length).toBeGreaterThan(0)

  const trees = await treesOf($, ['bash:u1'])
  expect(everything(s, trees)).not.toContain('SENTINEL')
})

test('privacy canary: no environment value but the session id, TMPDIR and HOME reaches a sink', { options: { notify: 'on', opencodeStats: 'on' } }, async ($, on) => {
  const kept: Record<string, string> = { CLAUDE_CODE_SESSION_ID: PARENT_ID, TMPDIR: '/tmp', HOME: '/home/u' }
  const s = sinksOf(on, name => kept[name] ?? `SENTINEL-ENV-${name}`, [
    { stdout: JSON.stringify({ sessions: 1, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.1, models: [] }), stderr: '' },
  ])
  const clock = mock.clock(on)

  await $.session.start(START) // child mode: the first report is written at once
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', run_in_background: true, command: 'node x/opencode-handoff/scripts/relay.mjs --lane quick --out-dir /tmp/p' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u2', run_in_background: true, command: SOL_RUN } as never)
  await clock.advance(500)
  await clock.advance(10_000) // a relay poll and a stats tick
  await $.session.end({ reason: 'exit' } as never)

  expect(s.writes.length).toBeGreaterThan(0)
  expect(s.runs.length).toBeGreaterThan(0)
  expect(s.ledger().runs['bash:u1']).toBeDefined()
  expect(s.store.length).toBeGreaterThan(0)

  const trees = await treesOf($, ['bash:u1', 'bash:u2'])
  expect(everything(s, trees)).not.toContain('SENTINEL')
})

test('privacy canary: a child report written holds numbers only, never prompt, command, codename or path', { options: { notify: 'on' } }, async ($, on) => {
  const s = sinksOf(on, name => (name === 'CLAUDE_CODE_SESSION_ID' ? PARENT_ID : undefined))
  const clock = mock.clock(on)

  await $.session.start(START)
  await $.agent.spawn({ subagentType: 'Explore', prompt: 'SENTINEL-PROMPT', description: 'SENTINEL-DESCRIPTION', name: 'SENTINEL-NAME' } as never)
  await $.tool.call({
    tool: 'Bash',
    tool_use_id: 'u1',
    run_in_background: true,
    command: 'cd /SENTINEL-PATH/deep && claude -p --model claude-sonnet-5-5 "SENTINEL-COMMAND"',
  } as never)
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: SONNET } as never)) {
    /* chunks are never read */
  }
  await clock.advance(500)
  await clock.advance(5000) // the timer writes the changed numbers
  await $.session.end({ reason: 'exit' } as never)

  expect(s.writes.length).toBeGreaterThanOrEqual(2)
  expect(s.writes.every(w => w.startsWith(`/tmp/watchducks-children/${fingerprint(PARENT_ID)}/S1.json\n`))).toBe(true)
  const last = JSON.parse(s.writes[s.writes.length - 1]!.split('\n').slice(1).join('\n')) as { rows: unknown[]; status: string }
  expect(last.status).toBe('done')
  expect(last.rows.length).toBeGreaterThan(0)

  const reports = s.writes.join('\n')
  expect(reports).not.toContain('SENTINEL')
  expect(reports).not.toContain('/work')
  expect(reports).not.toContain(PARENT_ID)
  // the ledger really did hold the runs: their codenames stay out of the report as well
  const runs = Object.values(s.ledger().runs)
  expect(runs.length).toBeGreaterThanOrEqual(2)
  for (const run of runs) {
    expect(run.codename.length).toBeGreaterThan(0)
    expect(reports).not.toContain(run.codename)
  }

  const trees = await treesOf($, ['bash:u1'])
  expect(everything(s, trees)).not.toContain('SENTINEL')
  // the working directory is in the live ledger only: never in the history, a file, a toast or a tree
  for (const sink of [s.store, s.writes, s.shown, trees]) expect(JSON.stringify(sink)).not.toContain('SENTINEL-PATH')
})

test('privacy canary: a child report read passes its numbers and nothing else', { options: { notify: 'on' } }, async ($, on) => {
  const files: Files = new Map()
  const s = sinksOf(on, () => undefined, [], files)
  const clock = mock.clock(on)
  const now = new Date(Date.now()).toISOString()
  const usage = (uncached: number) => ({ uncached, output: 0, cacheRead: 0, cacheWrite: 0 })
  const row = (implementer: string, model: string, uncached: number, extra: Record<string, unknown> = {}) => ({
    implementer,
    model,
    usage: usage(uncached),
    cost: uncached / 1000,
    costSource: 'estimated',
    ...extra,
  })
  // c1: valid numbers beside sentinel extras; c2: rows that are not identifiers, so the whole file must be rejected
  const head = { schema: 'watchducks.child.v1', startedAt: now, updatedAt: now, status: 'running' }
  // c1 ends the run (done), so its numbers also pass through the finished-run toast
  const valid = JSON.stringify({
    ...head,
    status: 'done',
    title: 'SENTINEL-REPORT-TITLE',
    text: 'SENTINEL-REPORT-TEXT',
    prompt: 'SENTINEL-REPORT-PROMPT',
    rows: [row('claude-code', SONNET, 100, { note: 'SENTINEL-ROW-NOTE', title: 'SENTINEL-ROW-TITLE', usage: { ...usage(100), note: 'SENTINEL-USAGE-NOTE' } })],
  })
  const invalid = JSON.stringify({
    ...head,
    title: 'SENTINEL-REPORT2-TITLE',
    rows: [row('claude-code', BAD_ID, 50), row(BAD_ID, SONNET, 25)],
  })

  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', run_in_background: true, command: CLAUDE_P } as never)
  await clock.advance(500)
  files.set(`${OWN_DIR}/c1.json`, { text: valid, mtimeMs: Date.now() + 1 })
  files.set(`${OWN_DIR}/c2.json`, { text: invalid, mtimeMs: Date.now() + 1 })
  await clock.advance(3000)
  await clock.advance(3000)
  await $.session.end({ reason: 'exit' } as never)

  // the valid numbers arrived on the card, and exactly those: the rejected file contributed nothing
  expect(s.ledger().runs['bash:u1']!.usage!.uncached).toBeGreaterThan(0)
  expect(s.ledger().runs['bash:u1']!.usage).toEqual(usage(100))
  expect(s.store.length).toBeGreaterThan(0)
  expect(s.shown.length).toBeGreaterThan(0)

  const trees = await treesOf($, ['bash:u1'])
  expect(everything(s, trees)).not.toContain('SENTINEL')
})
