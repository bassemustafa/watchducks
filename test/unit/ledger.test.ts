import { expect, test } from 'claude-code/testing'

import { emptyLedger, isKnownLoop, reduce, resolveRun, seriesWindow, totals, type Action } from '../../src/ledger'
import { recordFromLedger, stationRowsFromLedger } from '../../src/history'
import { PRICES } from '../../src/price'
import type { Ledger } from '../../types'

const T0 = Date.UTC(2026, 9, 9, 12)
const OPUS = 'claude-opus-5-5'
const apply = (l: Ledger, ...actions: Action[]): Ledger => actions.reduce((acc, a) => reduce(acc, a, PRICES), l)
const stepAt = (index: number, at: number, loop = 'a1'): Action => ({ type: 'step', loop, turnId: 't1', index, model: OPUS, usage: stepUsage(OPUS), at })
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

test('clear folds the removed runs into retired: the record keeps them, the live board does not', () => {
  const cleared = apply(emptyLedger('s1', T0), spawn('a1'), spawn('a2'),
    { type: 'turnComplete', loop: 'a2', turnId: 't1', reason: 'answer', at: T0 + 1 },
    { type: 'clear', at: T0 + 2 })
  const ops = (l: Ledger) => Object.values(recordFromLedger(l).days).flatMap(d => Object.values(d)).reduce((n, c) => n + c.ops, 0)
  expect(cleared.runs['a2']).toBeUndefined()
  expect(ops(cleared)).toBe(2)
  expect(stationRowsFromLedger(cleared).reduce((n, r) => n + r.ops, 0)).toBe(1)
  const twice = apply(cleared, { type: 'clear', at: T0 + 3 })
  expect(ops(twice)).toBe(2)
  const later = apply(twice, { type: 'turnComplete', loop: 'a1', turnId: 't2', reason: 'answer', at: T0 + 4 }, { type: 'clear', at: T0 + 5 })
  expect(ops(later)).toBe(2)
  expect(Object.values(later.retired).flatMap(d => Object.values(d)).reduce((n, c) => n + c.done, 0)).toBe(2)
})

test('clear drops retired day buckets older than 30 days before the clear and keeps the newer ones', () => {
  const DAY = 86_400_000
  const old = T0 - 60 * DAY
  const done = (id: string, at: number): Action[] => [
    { type: 'spawn', id, agentType: 'Explore', requestedModel: OPUS, at },
    { type: 'turnComplete', loop: id, turnId: 't1', reason: 'answer', at: at + 1 },
  ]
  const first = apply(emptyLedger('s1', old), ...done('o1', old), { type: 'clear', at: old + 2 })
  expect(Object.keys(first.retired)).toEqual(['2026-08-10'])
  const second = apply(first, ...done('n1', T0 - 5 * DAY), { type: 'clear', at: T0 })
  expect(Object.keys(second.retired)).toEqual(['2026-10-04'])
  const edge = apply(second, ...done('e1', T0 - 30 * DAY), { type: 'clear', at: T0 })
  expect(Object.keys(edge.retired).sort()).toEqual(['2026-09-09', '2026-10-04'])
})

test('countedSteps and turnsWithSteps are capped at 1024 keys and the newest key still dedupes', () => {
  let l = apply(emptyLedger('s1', T0), spawn('a1'))
  for (let i = 0; i < 5000; i++) l = reduce(l, step(i, OPUS, `t${i}`), PRICES)
  // past 1024 the maps drop to the newest 768 keys, then grow again: 5000 steps leave 888
  expect(Object.keys(l.countedSteps).length).toBe(888)
  expect(Object.keys(l.turnsWithSteps).length).toBe(888)
  expect(Object.hasOwn(l.countedSteps, 'a1|t4999|4999')).toBe(true)
  expect(Object.hasOwn(l.countedSteps, 'a1|t0|0')).toBe(false)
  const before = l.runs['a1']!.usage
  l = reduce(l, step(4999, OPUS, 't4999'), PRICES)
  expect(l.runs['a1']!.usage).toEqual(before)
})

test('adopt creates an agent run like a spawn, once, and the next step charges it', () => {
  let l = apply(emptyLedger('s1', T0), { type: 'adopt', id: 'f1', agentType: 'skill', parentId: 'a1', at: T0 })
  const r = l.runs['f1']!
  expect(r.kind).toBe('agent')
  expect(r.implementer).toBe('claude-code')
  expect(r.agentType).toBe('skill')
  expect(r.parentId).toBe('a1')
  expect(r.status).toBe('running')
  expect(l.order).toEqual(['f1'])
  l = apply(l, { type: 'adopt', id: 'f1', agentType: 'other', at: T0 + 1 }, stepAt(0, T0 + 2, 'f1'))
  expect(l.order).toEqual(['f1'])
  expect(l.runs['f1']!.agentType).toBe('skill')
  expect(l.runs['f1']!.usage?.uncached).toBe(1000)
  expect(l.overhead.usage.uncached).toBe(0)
})

test('a complete-only charge updates the run model and models', () => {
  const l = apply(emptyLedger('s1', T0), spawn('a1'),
    { type: 'turnComplete', loop: 'a1', turnId: 't9', reason: 'answer', usage: stepUsage('claude-sonnet-5-5'), at: T0 + 2000 })
  expect(l.runs['a1']!.model).toBe('claude-sonnet-5-5')
  expect(l.runs['a1']!.models).toEqual(['claude-sonnet-5-5'])
})

test('a reviewer is suspected for its 3 newest targets only', () => {
  const impl = (n: number): Action[] => [
    { type: 'bashStart', id: `bash:i${n}`, cls: { kind: 'cli', implementer: 'codex', workdir: '/work/a' }, at: T0 + n * 10 },
    { type: 'bashResult', id: `bash:i${n}`, isError: false, interrupted: false, at: T0 + n * 10 + 5 },
  ]
  const l = apply(emptyLedger('s1', T0), ...[1, 2, 3, 4].flatMap(impl),
    { type: 'bashStart', id: 'bash:rev', cls: { kind: 'relay', implementer: 'opencode', lane: 'review', readOnly: true, workdir: '/work/a' }, at: T0 + 100 })
  expect(l.runs['bash:i1']!.suspectedHandlers).toEqual([])
  for (const n of [2, 3, 4]) expect(l.runs[`bash:i${n}`]!.suspectedHandlers).toEqual(['bash:rev'])
})

test('a target lists the reviewers that picked it, newest first', () => {
  const l = apply(emptyLedger('s1', T0),
    { type: 'bashStart', id: 'bash:impl', cls: { kind: 'cli', implementer: 'codex', workdir: '/work/a' }, at: T0 },
    { type: 'bashResult', id: 'bash:impl', isError: false, interrupted: false, at: T0 + 10 },
    { type: 'bashStart', id: 'bash:r1', cls: { kind: 'relay', implementer: 'opencode', lane: 'review', readOnly: true, workdir: '/work/a' }, at: T0 + 20 },
    { type: 'bashStart', id: 'bash:r2', cls: { kind: 'relay', implementer: 'opencode', lane: 'review', readOnly: true, workdir: '/work/a' }, at: T0 + 30 })
  expect(l.runs['bash:impl']!.suspectedHandlers).toEqual(['bash:r2', 'bash:r1'])
})

const relay = (usage: { uncached: number; output: number; cacheRead: number; cacheWrite: number } | null): Action =>
  ({ type: 'relayResult', id: 'bash:r', at: T0 + 2, proj: { status: 'done', readOnly: false, costReported: null, usage, touchedFiles: null } })

test('a relay result adds its tokens to the series once and marks the result as read', () => {
  const start = apply(emptyLedger('s1', T0), { type: 'bashStart', id: 'bash:r', cls: { kind: 'relay', implementer: 'opencode', readOnly: false }, at: T0 })
  const used = { uncached: 1000, output: 100, cacheRead: 50, cacheWrite: 10 }
  const l = apply(start, relay(used))
  expect(l.runs['bash:r']!.resultRead).toBe(true)
  expect(l.tokenSeries).toEqual([1160])
  expect(apply(l, relay(used)).tokenSeries).toEqual([1160])
  expect(apply(start, relay(null)).tokenSeries).toEqual([])
})

test('seriesWindow aligns to the current minute, zero-fills and ages old activity out', () => {
  const MIN = 60_000
  let l = emptyLedger('s1', T0)
  expect(seriesWindow(l, T0)).toEqual(new Array(30).fill(0))
  l = apply(l, spawn('a1'), stepAt(0, T0), stepAt(1, T0 + 2 * MIN))
  const w = seriesWindow(l, T0 + 2 * MIN)
  expect(w.length).toBe(30)
  expect(w.slice(-3)).toEqual([1100, 0, 1100])
  expect(w.slice(0, 27).every(n => n === 0)).toBe(true)
  expect(seriesWindow(l, T0 + 4 * MIN, 5)).toEqual([1100, 0, 1100, 0, 0])
  expect(seriesWindow(l, T0 + 40 * MIN).every(n => n === 0)).toBe(true)
  expect(seriesWindow(l, T0 + 2 * MIN, 3)).toEqual([1100, 0, 1100])
})
