import { expect, test } from 'claude-code/testing'

import { emptyLedger, isKnownLoop, reduce, resolveRun, totals, type Action } from '../../src/ledger'
import { PRICES } from '../../src/price'
import type { Ledger } from '../../types'

const T0 = Date.UTC(2026, 9, 9, 12)
const OPUS = 'claude-opus-5-5'
const apply = (l: Ledger, ...actions: Action[]): Ledger => actions.reduce((acc, a) => reduce(acc, a, PRICES), l)
const spawn = (id: string): Action => ({ type: 'spawn', id, agentType: 'Explore', requestedModel: OPUS, at: T0 })
const stepUsage = (model: string) => ({ model, input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
const step = (index: number, model = OPUS, turnId = 't1'): Action => ({ type: 'step', loop: 'a1', turnId, index, model, effort: 'high', usage: stepUsage(model), at: T0 + 1000 })

function near(a: number | null | undefined, b: number): void { expect(typeof a === 'number' && Math.abs(a - b) < 1e-9).toBe(true) }

test('step then complete counts once', () => {
  const l = apply(emptyLedger('s1', T0), spawn('a1'), step(0), step(1),
    { type: 'turnComplete', loop: 'a1', turnId: 't1', reason: 'answer', usage: stepUsage(OPUS), at: T0 + 2000 })
  const r = l.runs['a1']!
  expect(r.usage).toEqual({ uncached: 2000, output: 200, cacheRead: 0, cacheWrite: 0 })
  near(r.cost, 0.012)
  expect(r.status).toBe('done')
  expect(r.usageSource).toBe('steps')
})

test('the same step dispatched twice is counted once', () => {
  const l = apply(emptyLedger('s1', T0), spawn('a1'), step(0), step(0))
  expect(l.runs['a1']!.usage).toEqual({ uncached: 1000, output: 100, cacheRead: 0, cacheWrite: 0 })
})

test('complete without any step but with usage is counted as complete', () => {
  const l = apply(emptyLedger('s1', T0), spawn('a1'),
    { type: 'turnComplete', loop: 'a1', turnId: 't9', reason: 'answer', usage: stepUsage(OPUS), at: T0 + 2000 })
  expect(l.runs['a1']!.usage).toEqual({ uncached: 1000, output: 100, cacheRead: 0, cacheWrite: 0 })
  expect(l.runs['a1']!.usageSource).toBe('complete')
})

test('steps on two models: models lists both and the cost sums per model', () => {
  const l = apply(emptyLedger('s1', T0), spawn('a1'), step(0, OPUS), step(1, 'claude-sonnet-5-5'))
  expect(l.runs['a1']!.models).toContain(OPUS)
  expect(l.runs['a1']!.models).toContain('claude-sonnet-5-5')
  near(l.runs['a1']!.cost, 0.009)
})

test('a step on an unpriced model sets costPartial and keeps the priced part only', () => {
  const l = apply(emptyLedger('s1', T0), spawn('a1'), step(0, 'openai/gpt-6.1-sol'), step(1, OPUS))
  expect(l.runs['a1']!.costPartial).toBe(true)
  near(l.runs['a1']!.cost, 0.006)
})

test('a loop id that is not a run goes to engine overhead', () => {
  const l = apply(emptyLedger('s1', T0), { type: 'step', loop: 'unknown-id', turnId: 't1', index: 0, model: OPUS, usage: stepUsage(OPUS), at: T0 })
  expect(l.overhead.usage.uncached).toBe(1000)
  expect(l.runs['unknown-id']).toBeUndefined()
  expect(Object.keys(l.runs)).toEqual([])
})

test('a step with no loop goes to HQ', () => {
  const l = apply(emptyLedger('s1', T0), { type: 'step', turnId: 't1', index: 0, model: OPUS, usage: stepUsage(OPUS), at: T0 })
  expect(l.hq.usage.uncached).toBe(1000)
})

test('a finished agent that takes a new step is running again', () => {
  let l = apply(emptyLedger('s1', T0), spawn('a1'), step(0),
    { type: 'turnComplete', loop: 'a1', turnId: 't1', reason: 'answer', at: T0 + 2000 })
  expect(l.runs['a1']!.status).toBe('done')
  l = apply(l, step(0, OPUS, 't2'))
  expect(l.runs['a1']!.status).toBe('running')
})

test('a foreground shell command is removed when its result arrives', () => {
  const l = apply(emptyLedger('s1', T0),
    { type: 'bashStart', id: 'bash:tu1', cls: { kind: 'shell' }, at: T0 },
    { type: 'bashResult', id: 'bash:tu1', isError: false, interrupted: false, at: T0 + 1 })
  expect(l.runs['bash:tu1']).toBeUndefined()
  expect(l.order).not.toContain('bash:tu1')
})

test('background runs gone from a snapshot are ended; a relay result then gives the real status', () => {
  let l = apply(emptyLedger('s1', T0),
    { type: 'bashStart', id: 'bash:tu2', cls: { kind: 'relay', implementer: 'opencode', readOnly: true, outDir: '/tmp/o1' }, at: T0 },
    { type: 'bashStart', id: 'bash:tu3', cls: { kind: 'cli', implementer: 'codex' }, at: T0 },
    { type: 'bashResult', id: 'bash:tu2', isError: false, interrupted: false, backgroundTaskId: 't1', at: T0 + 1 },
    { type: 'bashResult', id: 'bash:tu3', isError: false, interrupted: false, backgroundTaskId: 't2', at: T0 + 1 },
    { type: 'bgSnapshot', taskIds: ['t1', 't2'], at: T0 + 2 })
  expect(l.runs['bash:tu2']!.status).toBe('running')
  expect(l.runs['bash:tu3']!.status).toBe('running')
  l = reduce(l, { type: 'bgSnapshot', taskIds: [], at: T0 + 3 }, PRICES)
  expect(l.runs['bash:tu2']!.status).toBe('ended')
  expect(l.runs['bash:tu2']!.endedAt).toBe(T0 + 3)
  expect(l.runs['bash:tu3']!.status).toBe('ended')
  expect(l.runs['bash:tu3']!.endedAt).toBe(T0 + 3)
  l = reduce(l, { type: 'relayResult', id: 'bash:tu2', proj: { status: 'done', readOnly: true, costReported: 0, usage: null, touchedFiles: 0 }, at: T0 + 4 }, PRICES)
  expect(l.runs['bash:tu2']!.status).toBe('done')
})

test('a relay result with costReported 0 gives cost 0 from the report', () => {
  let l = apply(emptyLedger('s1', T0), { type: 'bashStart', id: 'bash:tu4', cls: { kind: 'relay', implementer: 'opencode', readOnly: false }, at: T0 })
  l = apply(l, { type: 'relayResult', id: 'bash:tu4', proj: { status: 'done', readOnly: false, costReported: 0, usage: null, touchedFiles: null }, at: T0 + 5 })
  expect(l.runs['bash:tu4']!.cost).toBe(0)
  expect(l.runs['bash:tu4']!.costSource).toBe('reported')
})

test('findings from the same call replace; findings from two calls add up', () => {
  const same = apply(emptyLedger('s1', T0), spawn('a1'),
    { type: 'findings', loop: 'a1', toolUseId: 'tu-a', count: 3, at: T0 + 1 },
    { type: 'findings', loop: 'a1', toolUseId: 'tu-a', count: 5, at: T0 + 2 })
  expect(same.runs['a1']!.bugsReported).toBe(5)
  const two = apply(emptyLedger('s1', T0), spawn('a1'),
    { type: 'findings', loop: 'a1', toolUseId: 'tu-a', count: 3, at: T0 + 1 },
    { type: 'findings', loop: 'a1', toolUseId: 'tu-b', count: 5, at: T0 + 2 })
  expect(two.runs['a1']!.bugsReported).toBe(8)
})

test('a verdict by lower-case codename adds a review', () => {
  let l = apply(emptyLedger('s1', T0), spawn('a1'))
  l = apply(l, { type: 'verdict', targetId: l.runs['a1']!.codename.toLowerCase(), bugs: 2, edits: 0, at: T0 + 1 })
  expect(l.runs['a1']!.reviews.length).toBe(1)
})

test('a second verdict from the same reviewer replaces the first', () => {
  let l = apply(emptyLedger('s1', T0), spawn('a1'), spawn('a2'))
  l = apply(l,
    { type: 'verdict', targetId: 'a1', reviewerId: 'a2', bugs: 2, edits: 0, at: T0 + 1 },
    { type: 'verdict', targetId: 'a1', reviewerId: 'a2', bugs: 4, edits: 1, at: T0 + 2 })
  expect(l.runs['a1']!.reviews.length).toBe(1)
  expect(l.runs['a1']!.reviews[0]!.bugs).toBe(4)
})

test('a verdict with an unknown target changes nothing', () => {
  const before = apply(emptyLedger('s1', T0), spawn('a1'))
  const after = apply(before, { type: 'verdict', targetId: 'nope', bugs: 1, at: T0 + 1 })
  expect(after).toEqual(before)
})

const handlerLedger = (reviewWorkdir: string) => apply(emptyLedger('s1', T0),
  { type: 'bashStart', id: 'bash:impl', cls: { kind: 'cli', implementer: 'codex', workdir: '/work/a' }, at: T0 },
  { type: 'bashResult', id: 'bash:impl', isError: false, interrupted: false, at: T0 + 10 },
  { type: 'bashStart', id: 'bash:rev', cls: { kind: 'relay', implementer: 'opencode', lane: 'review', readOnly: true, workdir: reviewWorkdir }, at: T0 + 20 })

test('a review relay on the same workdir after the work ended is a suspected handler', () => {
  expect(handlerLedger('/work/a').runs['bash:impl']!.suspectedHandlers).toEqual(['bash:rev'])
})

test('a review relay on another workdir suggests nothing', () => {
  expect(handlerLedger('/work/b').runs['bash:impl']!.suspectedHandlers).toEqual([])
})

test('clear keeps running runs and bumps the generation', () => {
  const l = apply(emptyLedger('s1', T0), spawn('a1'), spawn('a2'),
    { type: 'turnComplete', loop: 'a2', turnId: 't1', reason: 'answer', at: T0 + 1 },
    { type: 'clear', at: T0 + 2 })
  expect(l.generation).toBe(1)
  expect(l.runs['a1']).toBeDefined()
  expect(l.runs['a2']).toBeUndefined()
})

test('codenames of 50 spawns are unique', () => {
  let l = emptyLedger('s1', T0)
  for (let i = 0; i < 50; i++) l = apply(l, spawn(`a${i}`))
  expect(new Set(Object.values(l.runs).map(r => r.codename)).size).toBe(50)
})

test('the reducer never mutates its input ledger', () => {
  const before = apply(emptyLedger('s1', T0), spawn('a1'), step(0),
    { type: 'bashStart', id: 'bash:x', cls: { kind: 'cli', implementer: 'codex', workdir: '/work/a' }, at: T0 })
  const frozen = JSON.stringify(before)
  const actions: Action[] = [
    step(1), step(0, OPUS, 't2'), spawn('a2'),
    { type: 'turnComplete', loop: 'a1', turnId: 't1', reason: 'error', usage: stepUsage(OPUS), at: T0 + 5 },
    { type: 'bashResult', id: 'bash:x', isError: true, interrupted: false, at: T0 + 6 },
    { type: 'findings', loop: 'a1', toolUseId: 'tu', count: 2, at: T0 + 7 },
    { type: 'editCall', loop: 'a1', at: T0 + 8 },
    { type: 'verdict', targetId: 'a1', bugs: 1, at: T0 + 9 },
    { type: 'bgSnapshot', taskIds: [], at: T0 + 10 },
    { type: 'clear', at: T0 + 11 },
  ]
  for (const a of actions) reduce(before, a, PRICES)
  expect(JSON.stringify(before)).toBe(frozen)
})

test('a replayed turn.complete with usage is counted once', () => {
  const done: Action = { type: 'turnComplete', loop: 'a1', turnId: 't9', reason: 'answer', usage: stepUsage(OPUS), at: T0 + 2000 }
  const l = apply(emptyLedger('s1', T0), spawn('a1'), done, done)
  expect(l.runs['a1']!.usage).toEqual({ uncached: 1000, output: 100, cacheRead: 0, cacheWrite: 0 })
})

test('a relay result wins over the exit-code status and reported usage is used', () => {
  let l = apply(emptyLedger('s1', T0),
    { type: 'bashStart', id: 'bash:r', cls: { kind: 'relay', implementer: 'claude', readOnly: false, model: OPUS }, at: T0 },
    { type: 'bashResult', id: 'bash:r', isError: true, interrupted: false, at: T0 + 1 })
  expect(l.runs['bash:r']!.status).toBe('failed')
  l = apply(l, { type: 'relayResult', id: 'bash:r', at: T0 + 2,
    proj: { status: 'done', readOnly: false, costReported: null, usage: { uncached: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }, touchedFiles: 3 } })
  const r = l.runs['bash:r']!
  expect(r.status).toBe('done')
  expect(r.usageSource).toBe('relay')
  expect(r.costSource).toBe('estimated')
  near(r.cost, 0.006)
  expect(r.editCalls).toBe(3)
})

test('resolveRun, isKnownLoop and totals', () => {
  const l = apply(emptyLedger('s1', T0), spawn('a1'), step(0),
    { type: 'bashStart', id: 'bash:c', cls: { kind: 'cli', implementer: 'codex' }, at: T0 },
    { type: 'bashResult', id: 'bash:c', isError: false, interrupted: false, at: T0 + 1 })
  expect(isKnownLoop(l, 'a1')).toBe(true)
  expect(isKnownLoop(l, 'constructor')).toBe(false)
  expect(resolveRun(l, 'a1')).toBe(l.runs['a1']!)
  expect(resolveRun(l, l.runs['a1']!.codename.toLowerCase())).toBe(l.runs['a1']!)
  expect(resolveRun(l, 'nope')).toBeUndefined()
  const t = totals(l)
  expect(t.running).toBe(1)
  expect(t.done).toBe(1)
  expect(t.usage.uncached).toBe(1000)
  near(t.cost, 0.006)
  near(t.byImplementer['claude-code'], 0.006)
  expect(t.byImplementer['codex']).toBe(0)
  expect(t.costPartial).toBe(false)
})
