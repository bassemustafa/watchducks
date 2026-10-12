import type { On } from 'claude-code'
import type { MockClock } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import type { Ledger } from '../types'
import { STATS_ARGV, STATS_TIMEOUT_MS } from '../src/adapters/opencode-stats'
import { emptyLedger, totals, workdirKey } from '../src/ledger'

const START = { cwd: '/work', surface: null, isInteractive: true }
const ON = { options: { opencodeStats: 'on' } } as const
const SOL = 'cd /proj && opencode run -m openai/gpt-6.1-sol "x"'

function near(a: number | null | undefined, b: number): void {
  expect(typeof a === 'number' && Math.abs(a - b) < 1e-9).toBe(true)
}

const call = (id: string, command: string) => ({ tool: 'Bash', tool_use_id: id, command, run_in_background: true }) as never
const stop = { stop_hook_active: false, background_tasks: [] } as never

/** A scripted `opencode stats --json` stdout: every counter scales with `n`, one model row (openai/gpt-6.1-sol) mirrors the total. */
function statsJson(sessions: number, n: number, cost: number, extra: Record<string, unknown> = {}): string {
  const tokens = { input: n * 100, output: n * 10, reasoning: n, cache: { read: n * 1000, write: 0 } }
  return JSON.stringify({
    sessions,
    tokens,
    cost,
    models: [{ model: { id: 'gpt-6.1-sol', providerID: 'openai' }, tokens, cost }],
    ...extra,
  })
}

type Row = { model: string; input: number; cost: number; output?: number; read?: number }

/** A scripted stdout with independently populated model rows; the project total is their sum. */
function rowsJson(sessions: number, rows: readonly Row[], extra: Record<string, unknown> = {}): string {
  let input = 0
  let output = 0
  let read = 0
  let cost = 0
  const models = rows.map(r => {
    const [providerID, id] = r.model.split('/') as [string, string]
    input += r.input
    output += r.output ?? 0
    read += r.read ?? 0
    cost += r.cost
    return { model: { id, providerID }, tokens: { input: r.input, output: r.output ?? 0, reasoning: 0, cache: { read: r.read ?? 0, write: 0 } }, cost: r.cost }
  })
  return JSON.stringify({ sessions, tokens: { input, output, reasoning: 0, cache: { read, write: 0 } }, cost, models, ...extra })
}

const flat = (uncached: number) => ({ uncached, output: 0, cacheRead: 0, cacheWrite: 0 })

/** The mocked clock does not move `Date.now()`: spin so that runs started after this are later in wall-clock time. */
function spin(ms: number): void {
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    /* wait */
  }
}

/** Result files: stat answers for any path, a read answers `text()` (a read before it is there fails). */
function relayFs(on: On, text: () => string | null): void {
  on('fs.stat', async ($, e) => ({ value: { kind: 'file' as const, size: 400, mtimeMs: Date.now(), isLink: false, realPath: e.path } }))
  on('fs.read', async () => {
    const t = text()
    if (t === null) throw new Error('not there yet')
    return { value: t }
  })
}

const relayText = (fields: Record<string, unknown>): string =>
  JSON.stringify({ schema: 'delegate-relay.result.v1', tool: 'opencode', status: 'completed', ...fields })

type Reply = string |{ exitCode?: number; stdout?: string; stderr?: string; truncated?: boolean } | 'reject'
type Call = { argv: readonly string[]; cwd: string | undefined; timeoutMs: number | undefined }

// The test's `$` has no `state` noun: an observer beneath the plugin sees every ledger the plugin writes.
function watchLedger(on: On, seen: string[] = []): () => Ledger {
  let latest: Ledger = emptyLedger('', 0)
  on('state.set', { plugin: 'watchducks', key: 'ledger' }, async ($, e, next) => {
    latest = e.value as Ledger
    seen.push(JSON.stringify(e.value))
    return next(e)
  })
  return () => latest
}

// The world beneath the plugin: a clock, a store that records what is written, `opencode stats` answering the
// script in order (the last reply repeats), and a background Bash call that hands out one task id per call.
function world(on: On, replies: readonly Reply[]): { clock: MockClock; calls: Call[]; stored: string[] } {
  const calls: Call[] = []
  const stored: string[] = []
  on('command.register', async () => ({ value: { command: 'flock' } }))
  on('tool.register', async () => ({ value: { tool: 'mcp__watchducks__x' } }))
  on('session.id', async () => ({ value: 'S1' }))
  on('session.root', async () => ({ value: '/work' }))
  on('session.surfaces', async () => ({ value: ['terminal'] }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.end', async () => ({ sessionId: 'S1' }))
  on('store.keys', async () => ({ value: [] }))
  on('store.set', async ($, e) => {
    stored.push(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('classic.Stop', async () => ({}))
  on('tool.call', { tool: 'Bash' }, async ($, e) => ({ result: { backgroundTaskId: 't-' + e.tool_use_id } }) as never)
  on('process.run', async ($, e) => {
    calls.push({ argv: e.argv, cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!
    if (reply === 'reject') throw new Error('spawn failed')
    const r = typeof reply === 'string' ? { stdout: reply } : reply
    return {
      value: {
        exitCode: r.exitCode ?? 0,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        isStdoutTruncated: r.truncated ?? false,
        isStderrTruncated: false,
      },
    } as never
  })
  mock.env(on, {})
  return { clock: mock.clock(on), calls, stored }
}

test('an opencode background run gets live and final numbers from opencode stats', { options: { opencodeStats: 'on' } }, async ($, on) => {
  const ledger = watchLedger(on)
  const w = world(on, [statsJson(1, 1, 0.1), statsJson(2, 3, 0.4), statsJson(2, 5, 0.8)])
  await $.session.start(START)
  await $.tool.call(call('u1', SOL))

  await w.clock.advance(500) // the watch tick sees the new run: the baseline is taken at once
  expect(w.calls.length).toBe(1)
  expect(ledger().runs['bash:u1']!.usage).toBeNull()

  await w.clock.advance(10_000) // the next stats tick: the live numbers
  const live = ledger().runs['bash:u1']!
  expect(live.usage).toEqual({ uncached: 200, output: 22, cacheRead: 2000, cacheWrite: 0 })
  near(live.cost, 0.3)
  expect(live.usageSource).toBe('stats')
  expect(live.costSource).toBe('reported')
  expect(live.approx).toBeUndefined()
  expect(live.sharedKey).toBeUndefined()

  await $.classic.Stop(stop) // the run ends; one more snapshot follows
  expect(ledger().runs['bash:u1']!.status).toBe('ended')
  await w.clock.advance(10_000)
  const final = ledger().runs['bash:u1']!
  expect(final.usage).toEqual({ uncached: 400, output: 44, cacheRead: 4000, cacheWrite: 0 })
  near(final.cost, 0.7)
  expect(w.calls.length).toBe(3)

  await w.clock.advance(60_000) // the run is no longer followed
  expect(w.calls.length).toBe(3)
})

test('the process runs the fixed argv in the run working directory with the timeout', ON, async ($, on) => {
  const w = world(on, [statsJson(1, 1, 0.1)])
  await $.session.start(START)
  await $.tool.call(call('u1', SOL))
  await w.clock.advance(500)
  expect(w.calls.length).toBe(1)
  expect([...w.calls[0]!.argv]).toEqual([...STATS_ARGV])
  expect(w.calls[0]!.cwd).toBe('/proj')
  expect(w.calls[0]!.timeoutMs).toBe(STATS_TIMEOUT_MS)
})

test('a run with no working directory is measured in the session root', ON, async ($, on) => {
  const w = world(on, [statsJson(1, 1, 0.1)])
  await $.session.start(START)
  await $.tool.call(call('u1', 'opencode run -m openai/gpt-6.1-sol "x"'))
  await w.clock.advance(500)
  expect(w.calls.length).toBe(1)
  expect(w.calls[0]!.cwd).toBe('/work')
})

test('with the setting off no process is ever started', async ($, on) => {
  const w = world(on, [statsJson(1, 1, 0.1)])
  await $.session.start(START)
  await $.tool.call(call('u1', SOL))
  await w.clock.advance(60_000)
  expect(w.calls.length).toBe(0)
})

test('with the setting on but no opencode run no process is started', ON, async ($, on) => {
  const w = world(on, [statsJson(1, 1, 0.1)])
  await $.session.start(START)
  await $.tool.call(call('u1', 'cd /proj && codex exec "x"'))
  await w.clock.advance(60_000)
  expect(w.calls.length).toBe(0)
})

test('two overlapping same-model runs share one total, counted once, beside runs of other models and of none', ON, async ($, on) => {
  const ledger = watchLedger(on)
  // every model row is populated on its own; the project total is their sum
  const at = (sol: number, other: number, ghost: number): string =>
    rowsJson(sol === 100 ? 1 : 2, [
      { model: 'openai/gpt-6.1-sol', input: sol, cost: sol / 1000 },
      { model: 'openai/other-model', input: other, cost: other / 1000 },
      { model: 'x/ghost', input: ghost, cost: ghost / 1000 },
    ])
  const w = world(on, [at(100, 50, 0), at(300, 80, 70)])
  await $.session.start(START)
  await $.tool.call(call('u1', SOL))
  await $.tool.call(call('u2', SOL))
  await $.tool.call(call('u3', 'cd /proj && opencode run -m openai/other-model "x"'))
  await $.tool.call(call('u4', 'cd /proj && opencode run -m alias-of-ghost "x"'))
  await w.clock.advance(500)
  expect(w.calls.length).toBe(1) // one snapshot serves every run in the folder
  await w.clock.advance(10_000)
  expect(w.calls.length).toBe(2)

  const a = ledger().runs['bash:u1']!
  const b = ledger().runs['bash:u2']!
  const other = ledger().runs['bash:u3']!
  const alias = ledger().runs['bash:u4']!
  expect(a.sharedSize).toBe(2)
  expect(b.sharedSize).toBe(2)
  expect(typeof a.sharedKey).toBe('string')
  expect(b.sharedKey).toBe(a.sharedKey)
  expect(a.usage).toEqual(flat(200))
  expect(b.usage).toEqual(a.usage)
  near(a.cost, 0.2)
  // a model with its own row is measured by that row alone
  expect(other.sharedKey).toBeUndefined()
  expect(other.sharedSize).toBeUndefined()
  expect(other.usage).toEqual(flat(30))
  expect(other.approx).toBeUndefined()
  // a model that names no row is given the project total less the rows the others have, and says it is approximate
  expect(alias.sharedKey).toBeUndefined()
  expect(alias.usage).toEqual(flat(70))
  near(alias.cost, 0.07)
  expect(alias.approx).toBe(true)
  // the session total is the physical growth of the project total (450 - 150), counted once
  expect(totals(ledger()).usage).toEqual(flat(300))
  near(totals(ledger()).cost, 0.3)
})

test('two separate groups of the same folder and model keep their own keys and both count in the totals', ON, async ($, on) => {
  const ledger = watchLedger(on)
  const w = world(on, [
    statsJson(1, 1, 0.1),
    statsJson(2, 3, 0.4),
    statsJson(2, 5, 0.8), // group 1's final look: the second group's baseline too, taken just before it starts
    statsJson(3, 8, 1.4), // this reply repeats
  ])
  await $.session.start(START)
  await $.tool.call(call('u1', SOL))
  await $.tool.call(call('u2', SOL))
  await w.clock.advance(500)
  await w.clock.advance(10_000)
  await $.classic.Stop(stop) // group 1 ends
  await w.clock.advance(10_000) // its final snapshot
  expect(w.calls.length).toBe(3)
  const first = ledger().runs['bash:u1']!
  expect(first.status).toBe('ended')
  expect(first.sharedSize).toBe(2)
  expect(ledger().runs['bash:u2']!.sharedKey).toBe(first.sharedKey)
  expect(first.usage).toEqual({ uncached: 400, output: 44, cacheRead: 4000, cacheWrite: 0 })
  const firstKey = first.sharedKey

  // wall-clock time passes, so group 2 starts after group 1 ended
  spin(20)
  await $.tool.call(call('u3', SOL))
  await $.tool.call(call('u4', SOL))
  for (let i = 0; i < 6 && ledger().runs['bash:u3']!.usage === null; i++) await w.clock.advance(10_000)

  const c = ledger().runs['bash:u3']!
  const d = ledger().runs['bash:u4']!
  expect(c.sharedSize).toBe(2)
  expect(d.sharedSize).toBe(2)
  expect(typeof c.sharedKey).toBe('string')
  expect(d.sharedKey).toBe(c.sharedKey)
  expect(c.sharedKey).not.toBe(firstKey)
  expect(c.usage).toEqual({ uncached: 300, output: 33, cacheRead: 3000, cacheWrite: 0 })
  // group 1 kept its key and its numbers
  expect(ledger().runs['bash:u1']!.sharedKey).toBe(firstKey)
  expect(ledger().runs['bash:u2']!.sharedKey).toBe(firstKey)
  expect(ledger().runs['bash:u1']!.usage).toEqual({ uncached: 400, output: 44, cacheRead: 4000, cacheWrite: 0 })
  // both groups are in the total, each once
  const t = totals(ledger())
  expect(t.usage).toEqual({ uncached: 700, output: 77, cacheRead: 7000, cacheWrite: 0 })
  near(t.cost, 1.3)
})

test('more new opencode sessions than tracked runs marks the figures approximate', ON, async ($, on) => {
  const ledger = watchLedger(on)
  const w = world(on, [statsJson(1, 1, 0.1), statsJson(4, 3, 0.4)])
  await $.session.start(START)
  await $.tool.call(call('u1', SOL))
  await w.clock.advance(500)
  await w.clock.advance(10_000)
  expect(ledger().runs['bash:u1']!.approx).toBe(true)
  expect(ledger().runs['bash:u1']!.usage).toEqual({ uncached: 200, output: 22, cacheRead: 2000, cacheWrite: 0 })
})

test('three failures in a row stop the adapter for the session', ON, async ($, on) => {
  const ledger = watchLedger(on)
  const w = world(on, [{ exitCode: 1 }, 'reject', 'not json', statsJson(1, 1, 0.1)])
  await $.session.start(START)
  await $.tool.call(call('u1', SOL))
  await w.clock.advance(500)
  await w.clock.advance(10_000)
  await w.clock.advance(10_000)
  expect(w.calls.length).toBe(3)
  await w.clock.advance(120_000)
  expect(w.calls.length).toBe(3)
  expect(ledger().runs['bash:u1']!.usage).toBeNull()
})

test('a truncated stdout counts as a failure', ON, async ($, on) => {
  const w = world(on, [{ stdout: statsJson(1, 1, 0.1), truncated: true }])
  await $.session.start(START)
  await $.tool.call(call('u1', SOL))
  await w.clock.advance(500)
  await w.clock.advance(10_000)
  await w.clock.advance(10_000)
  expect(w.calls.length).toBe(3)
  await w.clock.advance(60_000)
  expect(w.calls.length).toBe(3)
})

test('a success resets the failure count', ON, async ($, on) => {
  const ledger = watchLedger(on)
  const bad: Reply = { exitCode: 2 }
  const w = world(on, [bad, bad, statsJson(1, 1, 0.1), bad, bad, statsJson(2, 3, 0.4)])
  await $.session.start(START)
  await $.tool.call(call('u1', SOL))
  await w.clock.advance(500)
  for (let i = 0; i < 5; i++) await w.clock.advance(10_000)
  expect(w.calls.length).toBe(6)
  expect(ledger().runs['bash:u1']!.usage).toEqual({ uncached: 200, output: 22, cacheRead: 2000, cacheWrite: 0 })
})

test('a relay whose cost the result.json reported starts no further process', ON, async ($, on) => {
  const RESULT =
    '{"schema":"delegate-relay.result.v1","tool":"opencode","status":"completed","totalCostUsd":0.02244,' +
    '"usage":{"input_tokens":20,"output_tokens":100,"cache_read_input_tokens":300,"cache_creation_input_tokens":0}}'
  const ledger = watchLedger(on)
  on('fs.stat', async ($, e) => ({
    value: {
      kind: 'file' as const,
      size: RESULT.length,
      mtimeMs: Date.now(),
      isLink: false,
      realPath: e.path.endsWith('result.json') ? '/tmp/o1/result.json' : e.path,
    },
  }))
  on('fs.read', async () => ({ value: RESULT }))
  const w = world(on, [statsJson(1, 1, 0.1), statsJson(2, 3, 0.4)])
  await $.session.start(START)
  await $.tool.call(call('u1', 'node x/opencode-delegate/scripts/relay.mjs --lane debate --out-dir /tmp/o1'))
  await w.clock.advance(3500) // the first relay poll applies the result
  const relay = ledger().runs['bash:u1']!
  expect(relay.usageSource).toBe('relay')
  expect(relay.costSource).toBe('reported')
  const before = w.calls.length
  expect(before).toBeLessThanOrEqual(1) // at most the baseline, taken before the result was there
  await w.clock.advance(60_000)
  expect(w.calls.length).toBe(before)
  expect(ledger().runs['bash:u1']!.usage).toEqual({ uncached: 20, output: 100, cacheRead: 300, cacheWrite: 0 })
  near(ledger().runs['bash:u1']!.cost, 0.02244)
})

test('the working directory is on the live run but never in a stored history record', ON, async ($, on) => {
  const ledger = watchLedger(on)
  const w = world(on, [statsJson(1, 1, 0.1), statsJson(2, 3, 0.4)])
  await $.session.start(START)
  await $.tool.call(call('u1', 'cd /sentinel-proj && opencode run -m openai/gpt-6.1-sol "x"'))
  await w.clock.advance(500)
  await w.clock.advance(10_000)
  const run = ledger().runs['bash:u1']!
  expect(run.workdir).toBe('/sentinel-proj')
  expect(run.workdirKey).toBe(workdirKey('/sentinel-proj'))
  await $.session.end({ reason: 'exit' } as never)
  expect(w.stored.length).toBeGreaterThan(0)
  for (const record of w.stored) expect(record).not.toContain('sentinel-proj')
})

test('stderr and unlisted stdout fields never reach state', ON, async ($, on) => {
  const seen: string[] = []
  const ledger = watchLedger(on, seen)
  const extra = { title: 'SENTINEL-TITLE', text: 'SENTINEL-TEXT' }
  const w = world(on, [
    { stdout: statsJson(1, 1, 0.1, extra), stderr: 'SENTINEL-STDERR' },
    { stdout: statsJson(2, 3, 0.4, extra), stderr: 'SENTINEL-STDERR' },
  ])
  await $.session.start(START)
  await $.tool.call(call('u1', SOL))
  await w.clock.advance(500)
  await w.clock.advance(10_000)
  expect(ledger().runs['bash:u1']!.usageSource).toBe('stats')
  expect(seen.length).toBeGreaterThan(0)
  for (const value of seen) expect(value).not.toContain('SENTINEL')
})

// ---- review fixes

test('a run with no working directory and a run that cd-ed to the session root share one folder', ON, async ($, on) => {
  const ledger = watchLedger(on)
  const w = world(on, [statsJson(1, 1, 0.1), statsJson(2, 3, 0.4)])
  await $.session.start(START)
  await $.tool.call(call('u1', 'opencode run -m openai/gpt-6.1-sol "x"'))
  await $.tool.call(call('u2', 'cd /work && opencode run -m openai/gpt-6.1-sol "x"'))
  await w.clock.advance(500)
  expect(w.calls.length).toBe(1) // one snapshot for the one folder
  expect(w.calls[0]!.cwd).toBe('/work')
  await w.clock.advance(10_000)
  expect(w.calls.length).toBe(2)
  const a = ledger().runs['bash:u1']!
  const b = ledger().runs['bash:u2']!
  expect(a.sharedSize).toBe(2)
  expect(b.sharedKey).toBe(a.sharedKey)
  expect(a.usage).toEqual({ uncached: 200, output: 22, cacheRead: 2000, cacheWrite: 0 })
})

test('/flock clear does not reset the failure breaker', ON, async ($, on) => {
  const w = world(on, [{ exitCode: 1 }, 'reject', 'not json', statsJson(1, 1, 0.1)])
  await $.session.start(START)
  await $.tool.call(call('u1', SOL))
  await w.clock.advance(500)
  await w.clock.advance(10_000)
  await w.clock.advance(10_000)
  expect(w.calls.length).toBe(3) // the breaker is open
  await $.command.run({ command: 'flock', args: 'clear' } as never) // u1 is running: it stays, the generation moves on
  await w.clock.advance(120_000)
  expect(w.calls.length).toBe(3)
})

test('/flock clear keeps a running run baseline and the pace per folder', ON, async ($, on) => {
  const ledger = watchLedger(on)
  const w = world(on, [statsJson(1, 1, 0.1), statsJson(2, 3, 0.4), statsJson(2, 5, 0.8)])
  await $.session.start(START)
  await $.tool.call(call('u1', SOL))
  await w.clock.advance(500)
  await w.clock.advance(10_000)
  expect(ledger().runs['bash:u1']!.usage).toEqual({ uncached: 200, output: 22, cacheRead: 2000, cacheWrite: 0 })
  const generation = ledger().generation
  await $.command.run({ command: 'flock', args: 'clear' } as never)
  expect(ledger().generation).toBe(generation + 1)
  expect(ledger().runs['bash:u1']).toBeDefined()
  await w.clock.advance(10_000)
  // no extra baseline snapshot; the figures go on from the same baseline
  expect(w.calls.length).toBe(3)
  expect(ledger().runs['bash:u1']!.usage).toEqual({ uncached: 400, output: 44, cacheRead: 4000, cacheWrite: 0 })
})

test('two runs whose models share a short id but not a provider are two cards, not one group', ON, async ($, on) => {
  const ledger = watchLedger(on)
  const w = world(on, [
    rowsJson(1, [{ model: 'p/m', input: 0, cost: 0 }, { model: 'q/m', input: 0, cost: 0 }]),
    rowsJson(2, [{ model: 'p/m', input: 10, cost: 1 }, { model: 'q/m', input: 20, cost: 2 }]),
  ])
  await $.session.start(START)
  await $.tool.call(call('u1', 'cd /proj && opencode run -m p/m "x"'))
  await $.tool.call(call('u2', 'cd /proj && opencode run -m q/m "x"'))
  await w.clock.advance(500)
  await w.clock.advance(10_000)
  const a = ledger().runs['bash:u1']!
  const b = ledger().runs['bash:u2']!
  expect(a.sharedKey).toBeUndefined()
  expect(b.sharedKey).toBeUndefined()
  expect(a.usage).toEqual(flat(10))
  near(a.cost, 1)
  expect(b.usage).toEqual(flat(20))
  near(b.cost, 2)
  expect(totals(ledger()).usage).toEqual(flat(30))
  near(totals(ledger()).cost, 3)
})

test('a run of an unknown model is given the project total less the known model row, so nothing is counted twice', ON, async ($, on) => {
  const ledger = watchLedger(on)
  const w = world(on, [
    rowsJson(1, [{ model: 'p/m', input: 0, cost: 0 }, { model: 'r/other', input: 0, cost: 0 }]),
    rowsJson(2, [{ model: 'p/m', input: 10, cost: 1 }, { model: 'r/other', input: 20, cost: 2 }]),
  ])
  await $.session.start(START)
  await $.tool.call(call('u1', 'cd /proj && opencode run -m p/m "x"'))
  await $.tool.call(call('u2', 'cd /proj && opencode run -m some-alias "x"'))
  await w.clock.advance(500)
  await w.clock.advance(10_000)
  const known = ledger().runs['bash:u1']!
  const unknown = ledger().runs['bash:u2']!
  expect(known.usage).toEqual(flat(10))
  near(known.cost, 1)
  expect(known.approx).toBeUndefined()
  expect(unknown.usage).toEqual(flat(20))
  near(unknown.cost, 2)
  expect(unknown.approx).toBe(true)
  expect(totals(ledger()).usage).toEqual(flat(30))
  near(totals(ledger()).cost, 3)
})

test('a run that starts after a snapshot and ends before the next permitted one still gets numbers', ON, async ($, on) => {
  const ledger = watchLedger(on)
  const at = (sessions: number, alpha: number, beta: number): string =>
    rowsJson(sessions, [{ model: 'openai/alpha', input: alpha, cost: alpha / 1000 }, { model: 'openai/beta', input: beta, cost: beta / 1000 }])
  const w = world(on, [at(1, 100, 50), at(2, 300, 80)])
  await $.session.start(START)
  await $.tool.call(call('uA', 'cd /proj && opencode run -m openai/alpha "x"'))
  await w.clock.advance(500) // the first snapshot, A's baseline
  expect(w.calls.length).toBe(1)
  spin(2)
  await $.tool.call(call('uB', 'cd /proj && opencode run -m openai/beta "x"'))
  await w.clock.advance(1000) // B is looked at: the snapshot taken just before it started is its baseline
  expect(w.calls.length).toBe(1)
  // B ends while A goes on
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 't-uA', type: 'shell', status: 'running', description: '' }] } as never)
  expect(ledger().runs['bash:uB']!.status).toBe('ended')
  expect(ledger().runs['bash:uA']!.status).toBe('running')
  await w.clock.advance(10_000) // the next permitted snapshot gives B its final figures
  expect(w.calls.length).toBe(2)
  const b = ledger().runs['bash:uB']!
  expect(b.usage).toEqual(flat(30))
  near(b.cost, 0.03)
  expect(b.approx).toBeUndefined()
  expect(ledger().runs['bash:uA']!.usage).toEqual(flat(200))
})

test('a relay cost held without usage beats later stats cost while stats tokens go on', ON, async ($, on) => {
  const ledger = watchLedger(on)
  let text: string | null = null
  relayFs(on, () => text)
  const sol = (input: number, cost: number): string => rowsJson(input === 0 ? 1 : 2, [{ model: 'openai/gpt-6.1-sol', input, cost }])
  const w = world(on, [sol(0, 0), sol(100, 1), sol(120, 1.2)])
  await $.session.start(START)
  await $.tool.call(call('u1', 'node x/opencode-delegate/scripts/relay.mjs --lane debate --model openai/gpt-6.1-sol --workdir /proj --out-dir /tmp/o1'))
  await w.clock.advance(500)
  await w.clock.advance(10_000)
  expect(ledger().runs['bash:u1']!.usage).toEqual(flat(100))
  near(ledger().runs['bash:u1']!.cost, 1)
  text = relayText({ totalCostUsd: 2 }) // a cost and no usage
  await w.clock.advance(3500)
  expect(ledger().runs['bash:u1']!.status).toBe('done')
  expect(ledger().runs['bash:u1']!.cost).toBe(2)
  await w.clock.advance(10_000) // the final snapshot
  expect(w.calls.length).toBe(3)
  const run = ledger().runs['bash:u1']!
  expect(run.usage).toEqual(flat(120))
  expect(run.usageSource).toBe('stats')
  expect(run.cost).toBe(2)
  expect(run.costSource).toBe('reported')
})

test('a relay result with exact usage and no cost leaves the stats cost on the card', ON, async ($, on) => {
  const ledger = watchLedger(on)
  let text: string | null = null
  relayFs(on, () => text)
  const sol = (input: number, cost: number): string => rowsJson(input === 0 ? 1 : 2, [{ model: 'openai/gpt-6.1-sol', input, cost }])
  const w = world(on, [sol(0, 0), sol(100, 1)])
  await $.session.start(START)
  await $.tool.call(call('u1', 'node x/opencode-delegate/scripts/relay.mjs --lane debate --model openai/gpt-6.1-sol --workdir /proj --out-dir /tmp/o1'))
  await w.clock.advance(500)
  await w.clock.advance(10_000)
  expect(ledger().runs['bash:u1']!.usageSource).toBe('stats')
  text = relayText({ usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
  await w.clock.advance(3500)
  await w.clock.advance(30_000) // the snapshots that would have followed
  const run = ledger().runs['bash:u1']!
  expect(run.usageSource).toBe('relay')
  expect(run.usage).toEqual(flat(100))
  expect(run.cost).toBe(1)
  expect(run.costSource).toBe('reported')
})

test('a group member that gets an exact relay result leaves the group; the other is given the rest', ON, async ($, on) => {
  const ledger = watchLedger(on)
  let text: string | null = null
  relayFs(on, () => text)
  const sol = (input: number, cost: number): string => rowsJson(input === 100 ? 1 : 2, [{ model: 'openai/gpt-6.1-sol', input, cost }])
  const w = world(on, [sol(100, 1), sol(200, 4)])
  await $.session.start(START)
  await $.tool.call(call('u1', SOL))
  await $.tool.call(call('u2', 'node x/opencode-delegate/scripts/relay.mjs --lane debate --model openai/gpt-6.1-sol --workdir /proj --out-dir /tmp/o2'))
  await w.clock.advance(500)
  await w.clock.advance(10_000)
  expect(ledger().runs['bash:u1']!.sharedSize).toBe(2)
  expect(ledger().runs['bash:u1']!.usage).toEqual(flat(100))
  near(ledger().runs['bash:u1']!.cost, 3)
  expect(ledger().runs['bash:u2']!.usage).toEqual(flat(100))

  text = relayText({ totalCostUsd: 1, usage: { input_tokens: 40, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
  await w.clock.advance(3500)
  const exact = ledger().runs['bash:u2']!
  expect(exact.usage).toEqual(flat(40))
  expect(exact.cost).toBe(1)
  expect(exact.sharedKey).toBeUndefined()
  expect(exact.sharedSize).toBeUndefined()
  await w.clock.advance(10_000) // the next snapshot gives the other member the rest
  const rest = ledger().runs['bash:u1']!
  expect(rest.usage).toEqual(flat(60))
  near(rest.cost, 2)
  expect(rest.approx).toBe(true)
  expect(rest.sharedKey).toBeUndefined()
  expect(totals(ledger()).usage).toEqual(flat(100))
  near(totals(ledger()).cost, 3)
})

test('a run that ended before the session did gets its final figures into the history', ON, async ($, on) => {
  const sol = (input: number, cost: number): string => rowsJson(input === 0 ? 1 : 2, [{ model: 'openai/gpt-6.1-sol', input, cost }])
  const w = world(on, [sol(0, 0), sol(100, 1), sol(150, 1.5)])
  await $.session.start(START)
  await $.tool.call(call('u1', SOL))
  await w.clock.advance(500)
  await w.clock.advance(10_000) // the last live figures: 100 / 1
  await $.classic.Stop(stop)
  expect(w.calls.length).toBe(2)
  await $.session.end({ reason: 'exit' } as never) // before the next tick
  expect(w.calls.length).toBe(3)
  expect(w.calls[2]!.timeoutMs).toBe(3000)
  const record = JSON.parse(w.stored[w.stored.length - 1]!) as { days: Record<string, Record<string, { uncached: number; costReported: number }>> }
  let uncached = 0
  let cost = 0
  for (const day of Object.values(record.days)) {
    for (const c of Object.values(day)) {
      uncached += c.uncached
      cost += c.costReported
    }
  }
  expect(uncached).toBe(150)
  near(cost, 1.5)
})

test('a failed snapshot at the end of the session leaves the last live figures', ON, async ($, on) => {
  const sol = (input: number, cost: number): string => rowsJson(input === 0 ? 1 : 2, [{ model: 'openai/gpt-6.1-sol', input, cost }])
  const w = world(on, [sol(0, 0), sol(100, 1), 'reject'])
  await $.session.start(START)
  await $.tool.call(call('u1', SOL))
  await w.clock.advance(500)
  await w.clock.advance(10_000)
  await $.classic.Stop(stop)
  await $.session.end({ reason: 'exit' } as never)
  expect(w.calls.length).toBe(3)
  const record = JSON.parse(w.stored[w.stored.length - 1]!) as { days: Record<string, Record<string, { uncached: number }>> }
  const uncached = Object.values(record.days).flatMap(d => Object.values(d)).reduce((n, c) => n + c.uncached, 0)
  expect(uncached).toBe(100)
})

test('a counter that falls between snapshots never takes the card backwards', ON, async ($, on) => {
  const ledger = watchLedger(on)
  const sol = (sessions: number, input: number): string => rowsJson(sessions, [{ model: 'openai/gpt-6.1-sol', input, cost: input / 1000 }])
  const w = world(on, [sol(1, 100), sol(2, 150), sol(2, 140), sol(2, 190)])
  await $.session.start(START)
  await $.tool.call(call('u1', SOL))
  await w.clock.advance(500)
  await w.clock.advance(10_000)
  expect(ledger().runs['bash:u1']!.usage).toEqual(flat(50))
  expect(ledger().runs['bash:u1']!.approx).toBeUndefined()
  await w.clock.advance(10_000) // the project total fell to 140: the card keeps 50
  const held = ledger().runs['bash:u1']!
  expect(held.usage).toEqual(flat(50))
  near(held.cost, 0.05)
  expect(held.approx).toBe(true)
  await w.clock.advance(10_000) // and goes on from there once it rises again
  expect(ledger().runs['bash:u1']!.usage).toEqual(flat(90))
  expect(ledger().runs['bash:u1']!.approx).toBeUndefined()
})
