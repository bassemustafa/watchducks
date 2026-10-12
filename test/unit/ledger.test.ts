import { expect, test } from 'claude-code/testing'

import { emptyLedger, isKnownLoop, normalizeDir, reduce, resolveRun, seriesWindow, totals, type Action } from '../../src/ledger'
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

test('a relay result names the tool of a run the classifier could not attribute', () => {
  const start = apply(emptyLedger('s1', T0), { type: 'bashStart', id: 'bash:r', cls: { kind: 'relay', implementer: 'unknown', readOnly: false }, at: T0 })
  const proj = { status: 'done', readOnly: false, implementer: 'gemini', costReported: null, usage: null, touchedFiles: null } as const
  expect(apply(start, { type: 'relayResult', id: 'bash:r', at: T0 + 2, proj }).runs['bash:r']!.implementer).toBe('gemini')
  expect(apply(start, relay(null)).runs['bash:r']!.implementer).toBe('unknown')
  const known = apply(emptyLedger('s1', T0), { type: 'bashStart', id: 'bash:r', cls: { kind: 'relay', implementer: 'codex', readOnly: false }, at: T0 },
    { type: 'relayResult', id: 'bash:r', at: T0 + 2, proj })
  expect(known.runs['bash:r']!.implementer).toBe('codex')
})

test('relayFound sets the out-dir of a relay that has none and nothing else', () => {
  const start = apply(emptyLedger('s1', T0),
    { type: 'bashStart', id: 'bash:r', cls: { kind: 'relay', implementer: 'unknown', readOnly: false }, at: T0 },
    { type: 'bashStart', id: 'bash:c', cls: { kind: 'cli', implementer: 'codex' }, at: T0 },
    { type: 'bashStart', id: 'bash:o', cls: { kind: 'relay', implementer: 'codex', readOnly: false, outDir: '/tmp/mine' }, at: T0 })
  const found = (id: string): Action => ({ type: 'relayFound', id, outDir: '/tmp/d1', at: T0 + 1 })
  expect(apply(start, found('bash:r')).runs['bash:r']!.outDir).toBe('/tmp/d1')
  expect(apply(start, found('bash:c')).runs['bash:c']!.outDir).toBeUndefined()
  expect(apply(start, found('bash:o')).runs['bash:o']!.outDir).toBe('/tmp/mine')
  expect(apply(start, found('bash:gone')).order).toEqual(start.order)
  const read = apply(start, { type: 'relayResult', id: 'bash:r', at: T0 + 2, proj: { status: 'running', readOnly: false, costReported: null, usage: null, touchedFiles: null } }, found('bash:r'))
  expect(read.runs['bash:r']!.outDir).toBeUndefined()
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

test('normalizeDir makes two spellings of one directory the same', () => {
  expect(normalizeDir('/a/./b', undefined)).toBe('/a/b')
  expect(normalizeDir('/a/b/.', undefined)).toBe('/a/b')
  expect(normalizeDir('/a//b///c/', undefined)).toBe('/a/b/c')
  expect(normalizeDir('/./a', undefined)).toBe('/a')
  expect(normalizeDir('/.', undefined)).toBe('/')
  expect(normalizeDir('~/./a//b', '/home/u')).toBe('/home/u/a/b')
  expect(normalizeDir('/a/../b', undefined)).toBe('/a/../b')
})

test('relayFound and a start with an explicit out-dir store the normalized form', () => {
  const start = apply(emptyLedger('s1', T0),
    { type: 'bashStart', id: 'bash:r', cls: { kind: 'relay', implementer: 'unknown', readOnly: false }, at: T0 },
    { type: 'bashStart', id: 'bash:o', cls: { kind: 'relay', implementer: 'codex', readOnly: false, outDir: '/tmp//o/./x/' }, at: T0 })
  expect(start.runs['bash:o']!.outDir).toBe('/tmp/o/x')
  const found = apply(start, { type: 'relayFound', id: 'bash:r', outDir: '/tmp/./d1//', at: T0 + 1 })
  expect(found.runs['bash:r']!.outDir).toBe('/tmp/d1')
})

test('normalizeDir expands ~, drops trailing slashes and refuses what it cannot resolve', () => {
  expect(normalizeDir('~', '/home/u')).toBe('/home/u')
  expect(normalizeDir('~/a', '/home/u')).toBe('/home/u/a')
  expect(normalizeDir('~/a/', '/home/u')).toBe('/home/u/a')
  expect(normalizeDir('/a/b/', undefined)).toBe('/a/b')
  expect(normalizeDir('/', undefined)).toBe('/')
  expect(normalizeDir('~x/a', '/home/u')).toBeUndefined()
  expect(normalizeDir('~/a', undefined)).toBeUndefined()
  expect(normalizeDir('~/a', 'rel')).toBeUndefined()
})

// ---- v0.2: adapter usage, precedence, shared groups, HQ by model

const OC_MODEL = 'openai/gpt-6.1-sol'
const cliStart = (id: string, implementer: 'opencode' | 'claude' = 'opencode', model = OC_MODEL): Action =>
  ({ type: 'bashStart', id, cls: { kind: 'cli', implementer, model, workdir: '/w' }, at: T0 })
const used = (uncached: number) => ({ uncached, output: 10, cacheRead: 0, cacheWrite: 0 })
const adapter = (id: string, source: 'stats' | 'child', uncached: number, over: Partial<Extract<Action, { type: 'adapterUsage' }>> = {}): Action =>
  ({ type: 'adapterUsage', id, source, usage: used(uncached), cost: 0.5, costSource: 'reported', at: T0 + 5000, ...over })
const relayDone = (id: string, costReported: number | null): Action => ({
  type: 'relayResult', id, at: T0 + 4000,
  proj: { status: 'done', readOnly: false, costReported, usage: used(777), touchedFiles: null },
})
const relayStart = (id: string): Action =>
  ({ type: 'bashStart', id, cls: { kind: 'relay', implementer: 'opencode', readOnly: false, model: OC_MODEL, workdir: '/w', outDir: '/o/1' }, at: T0 })

test('stats usage alone applies and its next snapshot replaces it rather than adding', () => {
  const l = apply(emptyLedger('s1', T0), cliStart('r1'), adapter('r1', 'stats', 100), adapter('r1', 'stats', 250, { cost: 0.75 }))
  const r = l.runs['r1']!
  expect(r.usage).toEqual(used(250))
  expect(r.usageSource).toBe('stats')
  expect(r.cost).toBe(0.75)
  expect(r.costSource).toBe('reported')
})

test('relay-reported usage and cost beat a child report and stats', () => {
  const l = apply(emptyLedger('s1', T0), relayStart('r1'), relayDone('r1', 0.9), adapter('r1', 'child', 1), adapter('r1', 'stats', 2))
  const r = l.runs['r1']!
  expect(r.usage).toEqual(used(777))
  expect(r.usageSource).toBe('relay')
  expect(r.cost).toBe(0.9)
})

test('a relay result without a reported cost does not block an adapter', () => {
  const l = apply(emptyLedger('s1', T0), relayStart('r1'), relayDone('r1', null), adapter('r1', 'stats', 5))
  expect(l.runs['r1']!.usageSource).toBe('stats')
  expect(l.runs['r1']!.usage).toEqual(used(5))
})

test('a child report beats stats whichever arrives first', () => {
  const stale = apply(emptyLedger('s1', T0), cliStart('r1'), adapter('r1', 'child', 40), adapter('r1', 'stats', 9))
  expect(stale.runs['r1']!.usageSource).toBe('child')
  expect(stale.runs['r1']!.usage).toEqual(used(40))
  const late = apply(emptyLedger('s1', T0), cliStart('r1'), adapter('r1', 'stats', 9), adapter('r1', 'child', 40))
  expect(late.runs['r1']!.usageSource).toBe('child')
  expect(late.runs['r1']!.usage).toEqual(used(40))
})

test('an adapter report for an unknown run changes nothing', () => {
  const l = emptyLedger('s1', T0)
  expect(apply(l, adapter('nope', 'stats', 1))).toEqual(l)
})

test('a newer adapter report without the approximate and shared fields clears them', () => {
  const l = apply(emptyLedger('s1', T0), cliStart('r1'),
    adapter('r1', 'stats', 10, { approx: true, sharedKey: 'k', sharedSize: 2 }), adapter('r1', 'stats', 20))
  const r = l.runs['r1']!
  expect(r.approx).toBeUndefined()
  expect(r.sharedKey).toBeUndefined()
  expect(r.sharedSize).toBeUndefined()
})

test('a child report ends a running run once, and never one the Bash side already ended', () => {
  const ended = apply(emptyLedger('s1', T0), cliStart('r1'), adapter('r1', 'child', 5, { status: 'done' }))
  expect(ended.runs['r1']!.status).toBe('done')
  expect(ended.runs['r1']!.endedAt).toBe(T0 + 5000)
  const running = apply(emptyLedger('s1', T0), cliStart('r1'), adapter('r1', 'child', 5, { status: 'running' }))
  expect(running.runs['r1']!.status).toBe('running')
  const failedBySide = apply(emptyLedger('s1', T0), cliStart('r1'),
    { type: 'bashResult', id: 'r1', isError: true, interrupted: false, at: T0 + 2000 }, adapter('r1', 'child', 5, { status: 'done' }))
  expect(failedBySide.runs['r1']!.status).toBe('failed')
  expect(failedBySide.runs['r1']!.endedAt).toBe(T0 + 2000)
})

const group = (extra: Partial<Extract<Action, { type: 'adapterUsage' }>> = {}): Action[] =>
  ['r1', 'r2', 'r3'].map(id => adapter(id, 'stats', 300, { sharedKey: 'oc|/w', sharedSize: 3, cost: 1.5, ...extra }))

test('a shared group of three counts once in totals and the station rows, also after one member ends', () => {
  const started = apply(emptyLedger('s1', T0), cliStart('r1'), cliStart('r2'), cliStart('r3'), ...group())
  const check = (l: Ledger) => {
    const t = totals(l)
    expect(t.usage).toEqual(used(300))
    near(t.cost, 1.5)
    near(t.byImplementer['opencode'], 1.5)
    const rows = stationRowsFromLedger(l)
    expect(rows.length).toBe(1)
    expect(rows[0]!.uncached).toBe(300)
    near(rows[0]!.costReported, 1.5)
    // three runs are three ops; only the spend is taken once
    expect(rows[0]!.ops).toBe(3)
    expect(rows[0]!.usageOps).toBe(1)
    for (const id of ['r1', 'r2', 'r3']) expect(l.runs[id]!.sharedSize).toBe(3)
  }
  check(started)
  // a later member ends: nothing moves
  const lateEnd = apply(started, { type: 'bashResult', id: 'r3', isError: false, interrupted: false, at: T0 + 6000 })
  check(lateEnd)
  expect(totals(lateEnd).done).toBe(1)
  expect(totals(lateEnd).running).toBe(2)
  // the first member ends early and the others catch up to the same total: still once
  const earlyEnd = apply(started, { type: 'bashResult', id: 'r1', isError: false, interrupted: false, at: T0 + 6000 },
    ...group({ at: T0 + 7000 }))
  check(earlyEnd)
})

test('runs with the same model but no shared key still count separately', () => {
  const l = apply(emptyLedger('s1', T0), cliStart('r1'), cliStart('r2'), adapter('r1', 'stats', 100), adapter('r2', 'stats', 100))
  expect(totals(l).usage).toEqual({ uncached: 200, output: 20, cacheRead: 0, cacheWrite: 0 })
  expect(stationRowsFromLedger(l)[0]!.uncached).toBe(200)
})

test('a child run puts its rows on their implementer × model station rows and not on HQ', () => {
  const rows = [
    { implementer: 'claude' as const, model: OPUS, usage: used(1000), cost: 2, costSource: 'estimated' as const },
    { implementer: 'opencode' as const, model: OC_MODEL, usage: used(400), cost: 0.5, costSource: 'reported' as const },
  ]
  const l = apply(emptyLedger('s1', T0), cliStart('c1', 'claude', OPUS), adapter('c1', 'child', 1400, { rows, cost: 2.5, costSource: 'estimated', model: OPUS }))
  const board = stationRowsFromLedger(l)
  const byKey = Object.fromEntries(board.map(r => [`${r.implementer}|${r.model}`, r]))
  expect(Object.keys(byKey).sort()).toEqual([`claude|${OPUS}`, `opencode|${OC_MODEL}`])
  expect(byKey[`opencode|${OC_MODEL}`]!.uncached).toBe(400)
  near(byKey[`opencode|${OC_MODEL}`]!.costReported, 0.5)
  expect(byKey[`claude|${OPUS}`]!.uncached).toBe(1000)
  near(byKey[`claude|${OPUS}`]!.costEstimated, 2)
  // one op, on the child's own row
  expect(byKey[`claude|${OPUS}`]!.ops).toBe(1)
  expect(byKey[`opencode|${OC_MODEL}`]!.ops).toBe(0)
  expect(l.hq.usage).toEqual({ uncached: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  expect(l.hqByModel).toEqual({})
  near(totals(l).byImplementer['opencode'], 0.5)
  near(totals(l).byImplementer['claude'], 2)
  expect(totals(l).usage).toEqual(used(1400))
})

test('a stored record keeps its shape with shared groups and child rows, and hqByModel is not in it', () => {
  const rows = [{ implementer: 'opencode' as const, model: OC_MODEL, usage: used(400), cost: 0.5, costSource: 'reported' as const }]
  const l = apply(emptyLedger('s1', T0), cliStart('c1', 'claude', OPUS), cliStart('r2'), cliStart('r3'),
    adapter('c1', 'child', 400, { rows }),
    adapter('r2', 'stats', 300, { sharedKey: 'k', sharedSize: 2 }), adapter('r3', 'stats', 300, { sharedKey: 'k', sharedSize: 2 }),
    { type: 'step', turnId: 't1', index: 0, model: OPUS, usage: stepUsage(OPUS), at: T0 })
  const record = recordFromLedger(l)
  expect(Object.keys(record).sort()).toEqual(['days', 'sessionStartedAt', 'v'])
  expect(JSON.stringify(record)).not.toContain('hqByModel')
  const day = Object.values(record.days)[0]!
  expect(day[`opencode|${OC_MODEL}`]!.uncached).toBe(700)
})

const flat = (tokens: number) => ({ uncached: tokens, output: 0, cacheRead: 0, cacheWrite: 0 })
const reported = (id: string, tokens: number, over: Partial<Extract<Action, { type: 'adapterUsage' }>> = {}): Action =>
  adapter(id, 'stats', 0, { usage: flat(tokens), ...over })
const nowSeries = (l: Ledger): number => seriesWindow(l, T0 + 5000, 1)[0]!

test('adapter usage adds only its rise to the tokens-per-minute series', () => {
  const l = apply(emptyLedger('s1', T0), cliStart('r1'), reported('r1', 10_000), reported('r1', 25_000))
  expect(nowSeries(l)).toBe(25_000)
  // a counter that fell adds nothing and takes nothing away
  expect(nowSeries(apply(l, reported('r1', 20_000)))).toBe(25_000)
})

test('a shared group adds its rise to the series once, whichever member reports first', () => {
  const shared = { sharedKey: 'k', sharedSize: 2 }
  const start = [cliStart('r1'), cliStart('r2')]
  const inOrder = apply(emptyLedger('s1', T0), ...start,
    reported('r1', 10_000, shared), reported('r2', 10_000, shared), reported('r1', 25_000, shared), reported('r2', 25_000, shared))
  expect(nowSeries(inOrder)).toBe(25_000)
  const crossed = apply(emptyLedger('s1', T0), ...start,
    reported('r1', 10_000, shared), reported('r2', 10_000, shared), reported('r2', 25_000, shared), reported('r1', 25_000, shared))
  expect(nowSeries(crossed)).toBe(25_000)
})

test('an adapter report a higher source ignores adds nothing to the series', () => {
  const l = apply(emptyLedger('s1', T0), relayStart('r1'), relayDone('r1', 0.9))
  const before = nowSeries(l)
  expect(nowSeries(apply(l, reported('r1', 50_000)))).toBe(before)
})

test('hqByModel: main-loop steps on two models are kept apart and add up to hq', () => {
  const l = apply(emptyLedger('s1', T0),
    { type: 'step', turnId: 't1', index: 0, model: OPUS, usage: stepUsage(OPUS), at: T0 },
    { type: 'step', turnId: 't1', index: 1, model: 'claude-sonnet-5-5', usage: stepUsage('claude-sonnet-5-5'), at: T0 },
    { type: 'step', turnId: 't2', index: 0, model: OPUS, usage: stepUsage(OPUS), at: T0 })
  const by = l.hqByModel!
  expect(Object.keys(by).sort()).toEqual([OPUS, 'claude-sonnet-5-5'])
  expect(by[OPUS]!.usage.uncached).toBe(2000)
  expect(by['claude-sonnet-5-5']!.usage.uncached).toBe(1000)
  const sum = Object.values(by).reduce((acc, s) => acc + s.usage.uncached, 0)
  expect(sum).toBe(l.hq.usage.uncached)
  near(Object.values(by).reduce((acc, s) => acc + (s.cost ?? 0), 0), l.hq.cost ?? 0)
})

test('hqByModel: a subagent step does not touch it, a main-loop turnComplete does', () => {
  const sub = apply(emptyLedger('s1', T0), spawn('a1'), step(0))
  expect(sub.hqByModel).toEqual({})
  const main = apply(sub, { type: 'turnComplete', turnId: 't9', reason: 'answer', usage: stepUsage(OPUS), at: T0 })
  expect(Object.keys(main.hqByModel!)).toEqual([OPUS])
  expect(main.hqByModel![OPUS]!.usage.uncached).toBe(1000)
})

test('hqByModel: the 17th model folds into other', () => {
  const steps: Action[] = []
  for (let i = 0; i < 17; i++) steps.push({ type: 'step', turnId: 't1', index: i, model: `m${i}`, usage: stepUsage(`m${i}`), at: T0 })
  steps.push({ type: 'step', turnId: 't1', index: 17, model: 'm0', usage: stepUsage('m0'), at: T0 })
  steps.push({ type: 'step', turnId: 't1', index: 18, model: 'm18', usage: stepUsage('m18'), at: T0 })
  const l = apply(emptyLedger('s1', T0), ...steps)
  const keys = Object.keys(l.hqByModel!)
  expect(keys.length).toBe(17)
  expect(keys.filter(k => k !== 'other').length).toBe(16)
  expect(l.hqByModel!['other']!.usage.uncached).toBe(2000)
  // a named model keeps accumulating after the cap
  expect(l.hqByModel!['m0']!.usage.uncached).toBe(2000)
})

// ---- review fixes: a relay cost holds without usage, exact results leave their group, clear retires a group once

const relayProj = (id: string, costReported: number | null, usage: ReturnType<typeof used> | null, at = T0 + 4000): Action =>
  ({ type: 'relayResult', id, at, proj: { status: 'done', readOnly: false, costReported, usage, touchedFiles: null } })
const sumRecord = (l: Ledger) => {
  const sum = { ops: 0, uncached: 0, costReported: 0 }
  for (const day of Object.values(recordFromLedger(l).days)) {
    for (const c of Object.values(day)) {
      sum.ops += c.ops
      sum.uncached += c.uncached
      sum.costReported += c.costReported
    }
  }
  return sum
}

test('a relay cost held without usage beats later stats cost, while stats tokens still update', () => {
  const l = apply(emptyLedger('s1', T0), relayStart('r1'), adapter('r1', 'stats', 100, { cost: 1 }), relayProj('r1', 2, null),
    adapter('r1', 'stats', 120, { cost: 1.2 }))
  const r = l.runs['r1']!
  expect(r.usage).toEqual(used(120))
  expect(r.usageSource).toBe('stats')
  expect(r.cost).toBe(2)
  expect(r.costSource).toBe('reported')
  expect(r.costLocked).toBe('relay')
})

test('an exact relay result drops the approximate, shared and rows marks an adapter had set', () => {
  const l = apply(emptyLedger('s1', T0), relayStart('r1'), cliStart('r2'),
    adapter('r1', 'stats', 100, { cost: 3, approx: true, sharedKey: 'k', sharedSize: 2 }),
    adapter('r2', 'stats', 100, { cost: 3, approx: true, sharedKey: 'k', sharedSize: 2 }),
    relayProj('r1', 1, used(40)))
  const r = l.runs['r1']!
  expect(r.usage).toEqual(used(40))
  expect(r.cost).toBe(1)
  expect(r.usageSource).toBe('relay')
  expect(r.sharedKey).toBeUndefined()
  expect(r.sharedSize).toBeUndefined()
  expect(r.approx).toBeUndefined()
  expect(r.rows).toBeUndefined()
  // the other member is untouched by the reducer: the stats glue re-measures it
  expect(l.runs['r2']!.sharedKey).toBe('k')
})

test('a relay result with usage but no cost keeps the adapter cost; one with neither keeps usage, source and cost', () => {
  const withUsage = apply(emptyLedger('s1', T0), relayStart('r1'), adapter('r1', 'stats', 100, { cost: 1 }), relayProj('r1', null, used(100)))
  expect(withUsage.runs['r1']!.usageSource).toBe('relay')
  expect(withUsage.runs['r1']!.usage).toEqual(used(100))
  expect(withUsage.runs['r1']!.cost).toBe(1)
  expect(withUsage.runs['r1']!.costSource).toBe('reported')
  const neither = apply(emptyLedger('s1', T0), relayStart('r1'), adapter('r1', 'stats', 100, { cost: 1 }), relayProj('r1', null, null))
  expect(neither.runs['r1']!.usageSource).toBe('stats')
  expect(neither.runs['r1']!.usage).toEqual(used(100))
  expect(neither.runs['r1']!.cost).toBe(1)
  expect(neither.runs['r1']!.costLocked).toBeUndefined()
})

test('a child report without a cost keeps the cost the run had', () => {
  const l = apply(emptyLedger('s1', T0), cliStart('r1'), adapter('r1', 'stats', 100, { cost: 1 }),
    adapter('r1', 'child', 50, { cost: null, costSource: null }))
  expect(l.runs['r1']!.usageSource).toBe('child')
  expect(l.runs['r1']!.usage).toEqual(used(50))
  expect(l.runs['r1']!.cost).toBe(1)
  expect(l.runs['r1']!.costSource).toBe('reported')
})

test('relay usage joins the series only by its rise over what stats already showed', () => {
  const flatRelay = (tokens: number): Action => relayProj('r1', 0.9, flat(tokens), T0 + 5000)
  const l = apply(emptyLedger('s1', T0), relayStart('r1'), reported('r1', 100), flatRelay(100))
  expect(nowSeries(l)).toBe(100)
  // a repeated result, or a lower one, adds nothing
  expect(nowSeries(apply(l, flatRelay(100)))).toBe(100)
  expect(nowSeries(apply(l, flatRelay(60)))).toBe(100)
  // a higher one adds the rise
  expect(nowSeries(apply(l, flatRelay(150)))).toBe(150)
  // with no stats before it, the whole usage joins
  expect(nowSeries(apply(emptyLedger('s1', T0), relayStart('r1'), flatRelay(100)))).toBe(100)
})

test('clearing one member of a shared group while another runs retires its ops, not the spend; the last member retires it once', () => {
  const shared = { sharedKey: 'k', sharedSize: 2, cost: 1 }
  const started = apply(emptyLedger('s1', T0), cliStart('r1'), cliStart('r2'), adapter('r1', 'stats', 100, shared), adapter('r2', 'stats', 100, shared))
  expect(sumRecord(started)).toEqual({ ops: 2, uncached: 100, costReported: 1 })
  const firstGone = apply(started, { type: 'bashResult', id: 'r1', isError: false, interrupted: false, at: T0 + 6000 }, { type: 'clear', at: T0 + 7000 })
  expect(Object.keys(firstGone.runs)).toEqual(['r2'])
  expect(sumRecord(firstGone)).toEqual({ ops: 2, uncached: 100, costReported: 1 })
  const bothGone = apply(firstGone, { type: 'bashResult', id: 'r2', isError: false, interrupted: false, at: T0 + 8000 }, { type: 'clear', at: T0 + 9000 })
  expect(Object.keys(bothGone.runs)).toEqual([])
  expect(sumRecord(bothGone)).toEqual({ ops: 2, uncached: 100, costReported: 1 })
  // a group cleared whole in one go is retired once as well
  const together = apply(started, { type: 'bashResult', id: 'r1', isError: false, interrupted: false, at: T0 + 6000 },
    { type: 'bashResult', id: 'r2', isError: false, interrupted: false, at: T0 + 6000 }, { type: 'clear', at: T0 + 7000 })
  expect(sumRecord(together)).toEqual({ ops: 2, uncached: 100, costReported: 1 })
})

test('hqByModel is read as empty on a ledger saved without it', () => {
  const { hqByModel: _gone, ...old } = emptyLedger('s1', T0)
  const l = apply(old, { type: 'step', turnId: 't1', index: 0, model: OPUS, usage: stepUsage(OPUS), at: T0 })
  expect(Object.keys(l.hqByModel!)).toEqual([OPUS])
  expect(emptyLedger('s1', T0).hqByModel).toEqual({})
})
