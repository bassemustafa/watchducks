import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { Ledger } from '../types'
import { utcDay } from '../src/history'
import { emptyLedger } from '../src/ledger'
import { INITIAL_UI } from '../src/state'

const START = { cwd: '/work', surface: null, isInteractive: true }
const RESULT = '{"schema":"delegate-relay.result.v1","tool":"opencode","status":"completed","totalCostUsd":0.5}'

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

// The test's `$` has no `store` noun: the store is a map beneath the plugin, read back by key.
function memoryStore(on: On): Map<string, unknown> {
  const entries = new Map<string, unknown>()
  on('store.keys', async () => ({ value: [...entries.keys()] }))
  on('store.get', async ($, e) => ({ value: entries.get(e.key) }))
  on('store.set', async ($, e) => {
    entries.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', async ($, e) => {
    entries.delete(e.key)
    return { value: undefined }
  })
  return entries
}

// The world beneath the plugin for a session: ids, surfaces, a store and a clock.
function world(on: On, surfaces: readonly string[], sessionId: () => string = () => 'S1') {
  on('command.register', async () => ({ value: { command: 'flock' } }))
  on('tool.register', async () => ({ value: { tool: 'mcp__watchducks__x' } }))
  on('session.id', async () => ({ value: sessionId() }))
  on('session.root', async () => ({ value: '/work' }))
  on('session.surfaces', async () => ({ value: surfaces as never }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.end', async () => ({ sessionId: 'S1' }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'l1' }))
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { backgroundTaskId: 't2' } }) as never)
  mock.env(on, {})
  return { store: memoryStore(on), clock: mock.clock(on) }
}

test('hot reload keeps the runs and the relay poll still updates them', async ($, on) => {
  const ledger = watchLedger(on)
  const { clock } = world(on, ['terminal'])
  on('fs.stat', async ($, e) => ({
    value: {
      kind: 'file' as const,
      size: RESULT.length,
      mtimeMs: Date.now(),
      isLink: false,
      realPath: e.path.endsWith('result.json') ? '/tmp/l/result.json' : e.path,
    },
  }))
  on('fs.read', async () => ({ value: RESULT }))
  await $.session.start(START)
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  await $.tool.call({
    tool: 'Bash',
    tool_use_id: 'l2',
    run_in_background: true,
    command: 'node x/opencode-delegate/scripts/relay.mjs --out-dir /tmp/l',
  } as never)
  await $.session.start(START) // hot reload: timers are rebuilt from state
  await clock.advance(3000)
  const runs = ledger().runs
  expect(runs['l1']).toBeDefined()
  near(runs['bash:l2']!.cost, 0.5)
})

test('/clear writes the old session history and resets the ledger with generation + 1', async ($, on) => {
  const ledger = watchLedger(on)
  let sessionId = 'S1'
  const { store } = world(on, ['terminal'], () => sessionId)
  await $.session.start(START)
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  const oldId = ledger().sessionId
  const generation = ledger().generation
  expect(Object.keys(ledger().runs)).toEqual(['l1'])
  sessionId = 'S2'
  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
  expect(store.get('history/v1/' + oldId)).toBeDefined()
  expect(ledger().sessionId).toBe('S2')
  expect(ledger().generation).toBe(generation + 1)
  expect(Object.keys(ledger().runs)).toEqual([])
})

test('a headless session writes no history unless recordHeadless is on', async ($, on) => {
  const ledger = watchLedger(on)
  const { store } = world(on, [])
  await $.session.start(START)
  const id = ledger().sessionId
  await $.session.end({ reason: 'exit' } as never)
  expect(id).toBe('S1')
  expect(store.get('history/v1/' + id)).toBeUndefined()
})

test('a headless session writes its history when recordHeadless is on', { options: { recordHeadless: 'on' } }, async ($, on) => {
  const ledger = watchLedger(on)
  const { store } = world(on, [])
  await $.session.start(START)
  const id = ledger().sessionId
  await $.session.end({ reason: 'exit' } as never)
  expect(id).toBe('S1')
  expect(store.get('history/v1/' + id)).toBeDefined()
})

test('a native /clear prunes the stored history down to 200 records', async ($, on) => {
  const { store } = world(on, ['terminal'])
  await $.session.start(START)
  const day = utcDay(Date.now())
  for (let i = 0; i < 201; i++) {
    store.set(`history/v1/old${i}`, { v: 1, sessionStartedAt: Date.now() - 100_000 + i, days: { [day]: { 'opencode|m': { ops: 1 } } } })
  }
  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
  expect(store.has('history/v1/old0')).toBe(false)
  expect([...store.keys()].filter(k => k.startsWith('history/v1/')).length).toBe(200)
})

test('a run that ends is saved to history within 2.5 s, not at the next minute tick', async ($, on) => {
  const { store, clock } = world(on, ['terminal'])
  on('turn.complete', async () => ({ text: '' }))
  await $.session.start(START)
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  await clock.advance(500)
  await $.turn.complete({ agentId: 'l1', turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false } as never)
  expect(store.get('history/v1/S1')).toBeUndefined()
  await clock.advance(500) // the watch tick sees the run done and schedules one write
  await clock.advance(2100)
  const record = store.get('history/v1/S1') as { days: Record<string, Record<string, { ops: number; done: number }>> }
  const counted = Object.values(record.days).flatMap(d => Object.values(d)).reduce((n, c) => n + c.done, 0)
  expect(counted).toBe(1)
})

test('a new session id resets the UI atom; a same-id reload leaves it', async ($, on) => {
  let sessionId = 'S1'
  const writes: unknown[] = []
  on('state.set', { plugin: 'watchducks', key: 'ui' }, async ($, e, next) => {
    writes.push(e.value)
    return next(e)
  })
  world(on, ['terminal'], () => sessionId)
  await $.session.start(START)
  const first = writes.length
  await $.session.start(START) // same id: a hot reload keeps closedByPerson / autoOpened
  expect(writes.length).toBe(first)
  sessionId = 'S2'
  await $.session.start(START)
  expect(writes.length).toBe(first + 1)
  expect(writes[writes.length - 1]).toEqual(INITIAL_UI)
  sessionId = 'S3'
  await $.session.end({ reason: 'clear', sessionId: 'S2', resume: { id: 'S2' } })
  expect(writes.length).toBe(first + 2)
  expect(writes[writes.length - 1]).toEqual(INITIAL_UI)
})
