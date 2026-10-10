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
function world(on: On, sessionId: () => string = () => 'S1'): MockClock {
  on('command.register', async () => ({ value: { command: 'flock' } }))
  on('tool.register', async () => ({ value: { tool: 'mcp__watchducks__x' } }))
  on('session.id', async () => ({ value: sessionId() }))
  on('session.root', async () => ({ value: '/work' }))
  on('session.surfaces', async () => ({ value: ['terminal'] }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.end', async () => ({ sessionId: 'S1' }))
  on('store.keys', async () => ({ value: [] }))
  on('store.set', async () => ({ value: undefined }))
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { backgroundTaskId: 't1' } }) as never)
  mock.env(on, {})
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
