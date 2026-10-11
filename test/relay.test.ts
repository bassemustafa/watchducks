import type { On } from 'claude-code'
import type { MockClock } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import type { Ledger } from '../types'
import { emptyLedger } from '../src/ledger'

const RESULT = '{"schema":"delegate-relay.result.v1","tool":"opencode","status":"completed","totalCostUsd":0.02244}'
const RELAY_CALL = { tool: 'Bash', tool_use_id: 'u1', run_in_background: true, command: 'node x/opencode-delegate/scripts/relay.mjs --lane debate --out-dir /tmp/o1' }
const START = { cwd: '/work', surface: null, isInteractive: true }

function near(a: number | null | undefined, b: number): void {
  expect(typeof a === 'number' && Math.abs(a - b) < 1e-9).toBe(true)
}

// The test's `$` has no `state` noun: an observer beneath the plugin sees every ledger the plugin writes.
function watchLedger(on: On): () => Ledger {
  let latest: Ledger = emptyLedger('', 0)
  on('state.set', { plugin: 'watchducks', key: 'ledger' }, async ($, e, next) => {
    latest = e.value as Ledger
    return next(e)
  })
  return () => latest
}

// The world beneath the plugin for a session that polls: a background relay Bash call, a store and a clock.
function world(on: On, sessionId: () => string = () => 'S1', env: Record<string, string> = {}, sessionRoot = '/work'): MockClock {
  on('command.register', async () => ({ value: { command: 'flock' } }))
  on('tool.register', async () => ({ value: { tool: 'mcp__watchducks__x' } }))
  on('session.id', async () => ({ value: sessionId() }))
  on('session.root', async () => ({ value: sessionRoot }))
  on('session.surfaces', async () => ({ value: ['terminal'] }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.end', async () => ({ sessionId: 'S1' }))
  on('store.keys', async () => ({ value: [] }))
  on('store.set', async () => ({ value: undefined }))
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { backgroundTaskId: 't1' } }) as never)
  mock.env(on, env)
  return mock.clock(on)
}

// A file system where the result.json lands where `landing` says and every other path lands on itself.
function files(on: On, landing: string, read: () => Promise<{ value: string }>, mtimeMs?: number): { reads: () => number } {
  let reads = 0
  on('fs.stat', async ($, e) => ({
    value: {
      kind: 'file' as const,
      size: RESULT.length,
      // written after the run started unless the test says otherwise
      mtimeMs: mtimeMs ?? Date.now(),
      isLink: false,
      realPath: e.path.endsWith('result.json') ? landing : e.path,
    },
  }))
  on('fs.read', async () => {
    reads += 1
    return read()
  })
  return { reads: () => reads }
}

test('polling reads a valid result.json under /tmp and records the reported cost', async ($, on) => {
  const ledger = watchLedger(on)
  const clock = world(on)
  files(on, '/tmp/o1/result.json', async () => ({ value: RESULT }))
  await $.session.start(START)
  await $.tool.call(RELAY_CALL as never)
  await clock.advance(3000)
  const run = ledger().runs['bash:u1']!
  near(run.cost, 0.02244)
  expect(run.costSource).toBe('reported')
})

test('a realPath outside every root is never read', async ($, on) => {
  const clock = world(on)
  const fs = files(on, '/home/x/.ssh/result.json', async () => ({ value: RESULT }))
  await $.session.start(START)
  await $.tool.call(RELAY_CALL as never)
  await clock.advance(3000)
  expect(fs.reads()).toBe(0)
})

test('a result.json older than the run (a reused out-dir) is never read', async ($, on) => {
  const ledger = watchLedger(on)
  const clock = world(on)
  const fs = files(on, '/tmp/o1/result.json', async () => ({ value: RESULT }), 0)
  await $.session.start(START)
  await $.tool.call(RELAY_CALL as never)
  await clock.advance(3000)
  expect(fs.reads()).toBe(0)
  expect(ledger().runs['bash:u1']!.cost).toBeNull()
})

test('a poll in flight when the ledger is cleared writes nothing into it', async ($, on) => {
  const ledger = watchLedger(on)
  let sessionId = 'S1'
  const clock = world(on, () => sessionId)
  let release: (text: string) => void = () => {}
  let calls = 0
  files(on, '/tmp/o1/result.json', () => {
    calls += 1
    // the first read stays pending until the test releases it; a later one fails and the run keeps its status
    if (calls > 1) return Promise.reject(new Error('gone'))
    return new Promise<{ value: string }>(resolve => {
      release = text => resolve({ value: text })
    })
  })
  await $.session.start(START)
  await $.tool.call(RELAY_CALL as never)
  await clock.advance(3000) // the read starts and stays pending
  sessionId = 'S2'
  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } }) // generation + 1, a fresh ledger
  await $.tool.call(RELAY_CALL as never) // the same relay call again, now recorded in the new ledger
  release(RESULT)
  await clock.advance(3000)
  const l = ledger()
  expect(l.generation).toBe(1)
  expect(l.runs['bash:u1']!.status).toBe('running')
  expect(l.runs['bash:u1']!.cost).toBeNull()
})

test('reload during a running relay poll keeps the run once and sets its cost once', async ($, on) => {
  const ledger = watchLedger(on)
  const clock = world(on)
  files(on, '/tmp/o1/result.json', async () => ({ value: RESULT }))
  await $.session.start(START)
  const before = Object.keys(ledger().runs).length
  await $.tool.call(RELAY_CALL as never)
  await $.session.start(START) // hot reload: timers are rebuilt from state
  await clock.advance(3000)
  const runs = ledger().runs
  expect(Object.keys(runs).length).toBe(before + 1)
  near(runs['bash:u1']!.cost, 0.02244)
})

test('a result.json over the size cap is never read', async ($, on) => {
  const clock = world(on)
  let reads = 0
  on('fs.stat', async ($, e) => ({
    value: { kind: 'file' as const, size: 2_000_000, mtimeMs: 0, isLink: false, realPath: e.path },
  }))
  on('fs.read', async () => {
    reads += 1
    return { value: RESULT }
  })
  await $.session.start(START)
  await $.tool.call(RELAY_CALL as never)
  await clock.advance(3000)
  expect(reads).toBe(0)
})

test('a finished result stops the polling: the file is read once', async ($, on) => {
  const clock = world(on)
  const fs = files(on, '/tmp/o1/result.json', async () => ({ value: RESULT }))
  await $.session.start(START)
  await $.tool.call(RELAY_CALL as never)
  await clock.advance(3000)
  await clock.advance(3000)
  await clock.advance(3000)
  expect(fs.reads()).toBe(1)
})

test('a result read before a reload is not applied again when a newer result.json appears', async ($, on) => {
  const ledger = watchLedger(on)
  const clock = world(on)
  let text = RESULT
  files(on, '/tmp/o1/result.json', async () => ({ value: text }))
  await $.session.start(START)
  await $.tool.call(RELAY_CALL as never)
  await clock.advance(3000)
  near(ledger().runs['bash:u1']!.cost, 0.02244)
  expect(ledger().runs['bash:u1']!.resultRead).toBe(true)
  // another run reused the out-dir; the reloaded poll must not take its result
  text = RESULT.replace('0.02244', '0.99')
  await $.session.start(START)
  await clock.advance(3000)
  near(ledger().runs['bash:u1']!.cost, 0.02244)
})

// Discovery (a relay with no --out-dir): an in-memory tree where every path lands on itself and a missing one is not a file.
type Node = { kind: 'dir' | 'file'; mtimeMs: number; text?: string }

function nodesOf(dirs: string[], files: Record<string, string> = {}, mtimeMs: number = Date.now()): Record<string, Node> {
  const out: Record<string, Node> = {}
  for (const dir of ['/work', '/tmp', ...dirs]) out[dir] = { kind: 'dir', mtimeMs }
  for (const [path, text] of Object.entries(files)) out[path] = { kind: 'file', mtimeMs, text }
  return out
}

function memfs(on: On, nodes: Record<string, Node>): { reads: () => string[]; lists: () => number } {
  const reads: string[] = []
  let lists = 0
  const at = (path: string): Node | undefined => (Object.hasOwn(nodes, path) ? nodes[path] : undefined)
  on('fs.stat', async ($, e) => {
    const node = at(e.path)
    if (!node) return { value: { kind: 'other' as const, size: 0, mtimeMs: 0, isLink: false } }
    return { value: { kind: node.kind, size: node.text?.length ?? 0, mtimeMs: node.mtimeMs, isLink: false, realPath: e.path } }
  })
  on('fs.list', async ($, e) => {
    lists += 1
    const entries = Object.entries(nodes)
      .filter(([path]) => path.slice(0, path.lastIndexOf('/')) === e.path)
      .map(([path, node]) => ({
        name: path.slice(path.lastIndexOf('/') + 1),
        kind: node.kind,
        size: node.text?.length ?? 0,
        mtimeMs: node.kind === 'file' ? node.mtimeMs : 0,
        isLink: false,
      }))
    return { value: entries }
  })
  on('fs.read', async ($, e) => {
    reads.push(e.path)
    return { value: at(e.path)?.text ?? '' }
  })
  return { reads: () => reads, lists: () => lists }
}

const USAGE = { input_tokens: 20, output_tokens: 100, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 }

function resultText(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 'delegate-relay.result.v1',
    tool: 'claude',
    status: 'completed',
    workdir: '/repo',
    startedAt: new Date(Date.now()).toISOString(),
    usage: USAGE,
    totalCostUsd: 0.5,
    ...patch,
  })
}

// a background relay that names no out-dir, started in /repo
const BARE_CALL = { tool: 'Bash', tool_use_id: 'u1', run_in_background: true, command: 'node /x/claude-delegate/scripts/relay.mjs --lane quick --brief b --cd /repo' }

async function polls(clock: MockClock, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await clock.advance(3000)
}

test('a relay with no out-dir gets the cost and usage of the result.json it finds under the temp dir', async ($, on) => {
  const ledger = watchLedger(on)
  const tmp = '/tmp/wd-disc-found'
  const clock = world(on, () => 'S1', { TMPDIR: tmp })
  const dir = `${tmp}/delegate-relay/repo-20261012T101500`
  memfs(on, nodesOf([tmp, `${tmp}/delegate-relay`, dir], { [`${dir}/result.json`]: resultText() }))
  await $.session.start(START)
  await $.tool.call(BARE_CALL as never)
  await polls(clock, 6)
  const run = ledger().runs['bash:u1']!
  expect(run.outDir).toBe(dir)
  near(run.cost, 0.5)
  expect(run.costSource).toBe('reported')
  expect(run.usage).toEqual({ uncached: 20, output: 100, cacheRead: 300, cacheWrite: 0 })
  expect(run.status).toBe('done')
  expect(run.resultRead).toBe(true)
})

test('discovery runs on every third poll, not before', async ($, on) => {
  const clock = world(on, () => 'S1', { TMPDIR: '/tmp/wd-disc-cadence' })
  const fs = memfs(on, nodesOf(['/tmp/wd-disc-cadence']))
  await $.session.start(START)
  await $.tool.call(BARE_CALL as never)
  await polls(clock, 2)
  expect(fs.lists()).toBe(0)
  await polls(clock, 1)
  expect(fs.lists()).toBeGreaterThan(0)
})

test('a result.json of another working directory is not taken, even when it started closer', async ($, on) => {
  const ledger = watchLedger(on)
  const tmp = '/tmp/wd-disc-workdir'
  const clock = world(on, () => 'S1', { TMPDIR: tmp })
  const mine = `${tmp}/delegate-relay/repo-b`
  const other = `${tmp}/delegate-relay/other-a`
  memfs(
    on,
    nodesOf([tmp, `${tmp}/delegate-relay`, mine, other], {
      [`${mine}/result.json`]: resultText({ startedAt: new Date(Date.now() + 1000).toISOString() }),
      [`${other}/result.json`]: resultText({ workdir: '/other', totalCostUsd: 9.9 }),
    }),
  )
  await $.session.start(START)
  await $.tool.call(BARE_CALL as never)
  await polls(clock, 6)
  const run = ledger().runs['bash:u1']!
  expect(run.outDir).toBe(mine)
  near(run.cost, 0.5)
})

test('with only another working directory result.json the run stays without an out-dir and nothing of it is stored', async ($, on) => {
  const ledger = watchLedger(on)
  const tmp = '/tmp/wd-disc-alone'
  const clock = world(on, () => 'S1', { TMPDIR: tmp })
  const other = `${tmp}/delegate-relay/other-a`
  memfs(on, nodesOf([tmp, `${tmp}/delegate-relay`, other], { [`${other}/result.json`]: resultText({ workdir: '/SENTINEL-OTHER', totalCostUsd: 9.9 }) }))
  await $.session.start(START)
  await $.tool.call(BARE_CALL as never)
  await polls(clock, 9)
  const run = ledger().runs['bash:u1']!
  expect(run.outDir).toBeUndefined()
  expect(run.cost).toBeNull()
  const stored = JSON.stringify(ledger())
  expect(stored).not.toContain('SENTINEL-OTHER')
  expect(stored).not.toContain('other-a')
})

test('a result.json from long before the run is read once and then left alone', async ($, on) => {
  const tmp = '/tmp/wd-disc-old'
  const clock = world(on, () => 'S1', { TMPDIR: tmp })
  const old = `${tmp}/delegate-relay/repo-old`
  const fs = memfs(on, nodesOf([tmp, `${tmp}/delegate-relay`, old], { [`${old}/result.json`]: resultText({ startedAt: new Date(Date.now() - 600_000).toISOString() }) }))
  await $.session.start(START)
  await $.tool.call(BARE_CALL as never)
  await polls(clock, 12)
  expect(fs.reads().length).toBe(1)
})

test('under the session root only the direct child directories are searched', async ($, on) => {
  const ledger = watchLedger(on)
  const tmp = '/tmp/wd-disc-session'
  const clock = world(on, () => 'S1', { TMPDIR: tmp })
  memfs(on, nodesOf([tmp, '/work/deep', '/work/deep/inner'], { '/work/deep/inner/result.json': resultText() }))
  await $.session.start(START)
  await $.tool.call(BARE_CALL as never)
  await polls(clock, 9)
  expect(ledger().runs['bash:u1']!.outDir).toBeUndefined()
})

test('a result.json directly under a session root child directory is found', async ($, on) => {
  const ledger = watchLedger(on)
  const tmp = '/tmp/wd-disc-sessionchild'
  const clock = world(on, () => 'S1', { TMPDIR: tmp })
  memfs(on, nodesOf([tmp, '/work/out-1'], { '/work/out-1/result.json': resultText() }))
  await $.session.start(START)
  await $.tool.call(BARE_CALL as never)
  await polls(clock, 6)
  const run = ledger().runs['bash:u1']!
  expect(run.outDir).toBe('/work/out-1')
  near(run.cost, 0.5)
})

test('more than 32 fresh result.json files of other runs do not starve the matching one, and an unchanged one is read once', async ($, on) => {
  const ledger = watchLedger(on)
  const tmp = '/tmp/wd-disc-many'
  const clock = world(on, () => 'S1', { TMPDIR: tmp })
  const base = `${tmp}/delegate-relay`
  const dirs = [tmp, base]
  const files: Record<string, string> = {}
  for (let i = 0; i < 40; i++) {
    const dir = `${base}/other-${String(i).padStart(2, '0')}`
    dirs.push(dir)
    files[`${dir}/result.json`] = resultText({ workdir: '/other' })
  }
  // listed last, so a pass that spends its reads in order never gets to it
  const mine = `${base}/repo-z`
  dirs.push(mine)
  files[`${mine}/result.json`] = resultText()
  const fs = memfs(on, nodesOf(dirs, files))
  await $.session.start(START)
  await $.tool.call(BARE_CALL as never)
  await polls(clock, 12)
  const run = ledger().runs['bash:u1']!
  expect(run.outDir).toBe(mine)
  near(run.cost, 0.5)
  const readsOf = (path: string): number => fs.reads().filter(p => p === path).length
  expect(readsOf(`${base}/other-00/result.json`)).toBe(1)
  expect(readsOf(`${base}/other-39/result.json`)).toBe(1)
})

test('one directory is given to one run only', async ($, on) => {
  const ledger = watchLedger(on)
  const tmp = '/tmp/wd-disc-once'
  const clock = world(on, () => 'S1', { TMPDIR: tmp })
  const dir = `${tmp}/delegate-relay/repo-x`
  memfs(on, nodesOf([tmp, `${tmp}/delegate-relay`, dir], { [`${dir}/result.json`]: resultText() }))
  await $.session.start(START)
  await $.tool.call(BARE_CALL as never)
  await $.tool.call({ ...BARE_CALL, tool_use_id: 'u2' } as never)
  await polls(clock, 8)
  const dirs = ['bash:u1', 'bash:u2'].map(id => ledger().runs[id]!.outDir).filter(d => d !== undefined)
  expect(dirs).toEqual([dir])
})

test('a relay started with --cd ~/repo and no out-dir is paired with the result.json of /home/u/repo', async ($, on) => {
  const ledger = watchLedger(on)
  const tmp = '/tmp/wd-disc-home'
  const clock = world(on, () => 'S1', { TMPDIR: tmp, HOME: '/home/u' })
  const dir = `${tmp}/delegate-relay/repo-20261012T101500`
  memfs(on, nodesOf([tmp, `${tmp}/delegate-relay`, dir], { [`${dir}/result.json`]: resultText({ workdir: '/home/u/repo' }) }))
  await $.session.start(START)
  await $.tool.call({ ...BARE_CALL, command: 'node /x/claude-delegate/scripts/relay.mjs --lane quick --brief b --cd ~/repo 2>&1 | tail -3' } as never)
  await polls(clock, 6)
  const run = ledger().runs['bash:u1']!
  expect(run.outDir).toBe(dir)
  near(run.cost, 0.5)
})

test('--out-dir ~/o is read at /home/u/o/result.json', async ($, on) => {
  const ledger = watchLedger(on)
  const clock = world(on, () => 'S1', { TMPDIR: '/tmp/wd-disc-out', HOME: '/home/u' }, '/home/u')
  const nodes = nodesOf(['/home/u', '/home/u/o'], { '/home/u/o/result.json': resultText() })
  memfs(on, nodes)
  await $.session.start(START)
  await $.tool.call({ ...BARE_CALL, command: 'node /x/claude-delegate/scripts/relay.mjs --lane quick --brief b --out-dir ~/o' } as never)
  await polls(clock, 2)
  const run = ledger().runs['bash:u1']!
  expect(run.outDir).toBe('/home/u/o')
  near(run.cost, 0.5)
})
