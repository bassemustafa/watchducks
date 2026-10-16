import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

import type { Ledger, UiState } from '../types'
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
function world(
  on: On,
  surfaces: readonly string[],
  sessionId: () => string = () => 'S1',
  surfacesGate: () => Promise<void> = async () => {},
  agentId: () => string = () => 'l1',
) {
  on('command.register', async () => ({ value: { command: 'flock' } }))
  on('tool.register', async () => ({ value: { tool: 'mcp__watchducks__x' } }))
  on('session.id', async () => ({ value: sessionId() }))
  on('session.root', async () => ({ value: '/work' }))
  on('session.surfaces', async () => {
    await surfacesGate()
    return { value: surfaces as never }
  })
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.end', async () => ({ sessionId: 'S1' }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: agentId() }))
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
    command: 'node x/opencode-delegation/scripts/relay.mjs --out-dir /tmp/l',
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

type Counted = { done: number; vetted: number; bugs: number }

function counted(value: unknown): Counted {
  const record = value as { days: Record<string, Record<string, Counted>> }
  const sum: Counted = { done: 0, vetted: 0, bugs: 0 }
  for (const bucket of Object.values(record.days)) {
    for (const c of Object.values(bucket)) {
      sum.done += c.done
      sum.vetted += c.vetted
      sum.bugs += c.bugs
    }
  }
  return sum
}

test('a verdict, then a replaced verdict, on a run that is already done are each saved within 2.5 s', async ($, on) => {
  const ledger = watchLedger(on)
  const { store, clock } = world(on, ['terminal'])
  on('turn.complete', async () => ({ text: '' }))
  await $.session.start(START)
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  await $.turn.complete({ agentId: 'l1', turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false } as never)
  await clock.advance(500) // the watch tick sees the run done and schedules one write
  await clock.advance(2100)
  expect(counted(store.get('history/v1/S1'))).toEqual({ done: 1, vetted: 0, bugs: 0 })

  const code = ledger().runs['l1']!.codename
  await $.tool.call({ tool: 'mcp__watchducks__verdict', target: code, bugs: 2 } as never)
  await clock.advance(500)
  await clock.advance(2100)
  expect(counted(store.get('history/v1/S1'))).toEqual({ done: 1, vetted: 1, bugs: 2 })

  // the same reviewer again: the review count stays 1, only the bug count moves
  await $.tool.call({ tool: 'mcp__watchducks__verdict', target: code, bugs: 5 } as never)
  await clock.advance(500)
  await clock.advance(2100)
  expect(counted(store.get('history/v1/S1'))).toEqual({ done: 1, vetted: 1, bugs: 5 })
})

test('history saves never overlap: a change during a save is saved right after it', async ($, on) => {
  const ledger = watchLedger(on)
  let active = 0
  let maxActive = 0
  let calls = 0
  const waiting: Array<() => void> = []
  const gate = async (): Promise<void> => {
    calls += 1
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise<void>(resolve => waiting.push(resolve))
    active -= 1
  }
  const { store, clock } = world(on, ['terminal'], () => 'S1', gate)
  on('turn.complete', async () => ({ text: '' }))
  await $.session.start(START)
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  await clock.advance(500)
  await clock.advance(2100) // the first save starts and waits on the surfaces answer
  expect(calls).toBe(1)

  await $.turn.complete({ agentId: 'l1', turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false } as never)
  await clock.advance(500)
  await clock.advance(2100)
  await $.tool.call({ tool: 'mcp__watchducks__verdict', target: ledger().runs['l1']!.codename, bugs: 1 } as never)
  await clock.advance(500)
  await clock.advance(2100)
  expect(maxActive).toBe(1)

  for (let i = 0; i < 10; i++) {
    while (waiting.length > 0) waiting.shift()!()
    await clock.advance(2100)
  }
  expect(maxActive).toBe(1)
  expect(calls).toBeGreaterThan(1)
  expect(counted(store.get('history/v1/S1'))).toEqual({ done: 1, vetted: 1, bugs: 1 })
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

test('runs ending in one tick each get a stamp entry and each entry clears on its own', async ($, on) => {
  let n = 0
  const { clock } = world(on, ['terminal'], undefined, undefined, () => `m${++n}`)
  let latest: UiState = INITIAL_UI
  on('state.set', { plugin: 'watchducks', key: 'ui' }, async ($, e, next) => {
    latest = e.value as UiState
    return next(e)
  })
  on('turn.complete', async () => ({ text: '' }))
  await $.session.start(START)
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  await clock.advance(100)
  await $.turn.complete({ agentId: 'm1', turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false } as never)
  await $.turn.complete({ agentId: 'm2', turnId: 't2', reason: 'aborted', answer: '', durationMs: 1, isAborted: true } as never)
  await clock.advance(600)
  expect(latest.stamps?.['m1']?.kind).toBe('done')
  expect(latest.stamps?.['m2']?.kind).toBe('killed')
  await clock.advance(1600)
  expect(latest.stamps).toBeUndefined()
})

// A pane drawn as the engine draws it on a surface; the timer blits only what the last render mounted.
function mountPane($: Engine, surface: 'terminal' | 'desktop') {
  return $.ui.mount({
    plugin: 'watchducks',
    surface,
    component: 'Pane',
    requestId: 'flock',
    props: { title: 'The Flock', isFocused: false, bodyColumns: 52, placement: 'dock' } as never,
    viewport: { columns: 56, rows: 40, isFullscreen: true },
  })
}

// One running agent, the flock pane placed and drawn, and a recorder of the blit keys.
async function motionWorld($: Engine, on: On, surface: 'terminal' | 'desktop') {
  const { clock } = world(on, [surface])
  const keys: string[] = []
  on('ui.blit', async (_$, e) => {
    keys.push((e as unknown as { key: string }).key)
    return { value: {} }
  })
  on('ui.panes', async () => ({ value: [{ id: 'flock', title: 'The Flock', isShown: true, isFocused: false, isPlaced: true }] }))
  // the first watch tick auto-opens the sidebar beside a fullscreen transcript
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('turn.complete', async () => ({ text: '' }))
  await $.session.start(START)
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  await clock.advance(100)
  const m = await mountPane($, surface)
  await m.drawn()
  return { clock, keys, m }
}

test('a running card on the terminal gets radar, dot and duck blits from the animation timer', async ($, on) => {
  const { clock, keys } = await motionWorld($, on, 'terminal')
  await clock.advance(1000)
  expect(keys).toContain('radar')
  // the dot belongs to the group card the run is in, keyed by a hash of the group id
  expect(keys.some(k => /^dot:g[0-9a-f]+$/.test(k))).toBe(true)
  expect(keys).toContain('duck')
})

test('the desktop surface gets no blit at all', async ($, on) => {
  const { clock, keys } = await motionWorld($, on, 'desktop')
  await clock.advance(1000)
  expect(keys).toEqual([])
})

test('motion off blits nothing', { options: { motion: 'off' } }, async ($, on) => {
  const { clock, keys } = await motionWorld($, on, 'terminal')
  await clock.advance(1000)
  expect(keys).toEqual([])
})

test('a stamp is blitted while it reveals and stops after STAMP_MS', async ($, on) => {
  const { clock, keys, m } = await motionWorld($, on, 'terminal')
  await $.turn.complete({ agentId: 'l1', turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false } as never)
  await clock.advance(600) // the watch tick stamps the run
  await m.drawn()
  keys.length = 0
  await clock.advance(600)
  expect(keys.some(k => /^stamp:g[0-9a-f]+$/.test(k))).toBe(true)
  await clock.advance(1200) // past STAMP_MS; the stamp entry has cleared
  await m.drawn()
  keys.length = 0
  await clock.advance(1000)
  expect(keys.some(k => k.startsWith('stamp:'))).toBe(false)
})
