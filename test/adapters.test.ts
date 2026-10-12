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

type Reply = string | { exitCode?: number; stdout?: string; stderr?: string; truncated?: boolean } | 'reject'
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

test('two overlapping same-model runs in one folder share one total, counted once', ON, async ($, on) => {
  const ledger = watchLedger(on)
  const w = world(on, [statsJson(1, 1, 0.1), statsJson(2, 3, 0.4)])
  await $.session.start(START)
  await $.tool.call(call('u1', SOL))
  await $.tool.call(call('u2', SOL))
  await $.tool.call(call('u3', 'cd /proj && opencode run -m openai/other-model "x"'))
  await w.clock.advance(500)
  expect(w.calls.length).toBe(1) // one snapshot serves every run in the folder
  await w.clock.advance(10_000)
  expect(w.calls.length).toBe(2)

  const a = ledger().runs['bash:u1']!
  const b = ledger().runs['bash:u2']!
  const other = ledger().runs['bash:u3']!
  expect(a.sharedSize).toBe(2)
  expect(b.sharedSize).toBe(2)
  expect(typeof a.sharedKey).toBe('string')
  expect(b.sharedKey).toBe(a.sharedKey)
  expect(a.usage).toEqual({ uncached: 200, output: 22, cacheRead: 2000, cacheWrite: 0 })
  expect(b.usage).toEqual(a.usage)
  expect(other.sharedKey).toBeUndefined()
  expect(other.sharedSize).toBeUndefined()
  // the group is in the session total once; the third run measured by the folder total adds its own
  expect(other.usage).toEqual({ uncached: 200, output: 22, cacheRead: 2000, cacheWrite: 0 })
  expect(totals(ledger()).usage).toEqual({ uncached: 400, output: 44, cacheRead: 4000, cacheWrite: 0 })
})

test('two separate groups of the same folder and model keep their own keys and both count in the totals', ON, async ($, on) => {
  const ledger = watchLedger(on)
  const w = world(on, [
    statsJson(1, 1, 0.1),
    statsJson(2, 3, 0.4),
    statsJson(2, 5, 0.8),
    statsJson(2, 6, 0.9), // the second group's baseline; this reply repeats
    statsJson(3, 8, 1.4),
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
  for (const t0 = Date.now(); Date.now() - t0 < 20; ) {
    /* spin: the mocked clock does not move Date.now() */
  }
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
  expect(c.usage).toEqual({ uncached: 200, output: 22, cacheRead: 2000, cacheWrite: 0 })
  // group 1 kept its key and its numbers
  expect(ledger().runs['bash:u1']!.sharedKey).toBe(firstKey)
  expect(ledger().runs['bash:u2']!.sharedKey).toBe(firstKey)
  expect(ledger().runs['bash:u1']!.usage).toEqual({ uncached: 400, output: 44, cacheRead: 4000, cacheWrite: 0 })
  // both groups are in the total, each once
  const t = totals(ledger())
  expect(t.usage).toEqual({ uncached: 600, output: 66, cacheRead: 6000, cacheWrite: 0 })
  near(t.cost, 1.2)
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
