import { expect, test } from 'claude-code/testing'

import { addRunsToDays, aggregateHistory, pruneHistory, recordFromLedger, stationRowsFromLedger, utcDay } from '../../src/history'
import type { HistoryRecord, Ledger, Run } from '../../types'

const ZERO = { usage: { uncached: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: null, costPartial: false }

function run(id: string, over: Partial<Run>): Run {
  return {
    id, kind: 'relay', codename: 'TEAL-00', implementer: 'opencode', readOnly: false,
    status: 'done', startedAt: Date.UTC(2026, 9, 9, 10), endedAt: Date.UTC(2026, 9, 9, 11),
    usage: null, usageSource: null, cost: null, costSource: null, costPartial: false,
    editCalls: 0, bugsReported: 0, reviews: [], suspectedHandlers: [], ...over,
  }
}

function ledgerOf(runs: Run[]): Ledger {
  return {
    v: 1, generation: 0, sessionId: 's1', sessionStartedAt: Date.UTC(2026, 9, 9),
    runs: Object.fromEntries(runs.map(r => [r.id, r])), order: runs.map(r => r.id),
    hq: ZERO, overhead: ZERO, turnsWithSteps: {}, countedSteps: {}, findings: {}, bgSeen: {},
    tokenSeries: [], seriesEndMinute: 0, retired: {},
  }
}

const counters = () => ({
  ops: 1, done: 1, failed: 0, killed: 0, ended: 0, uncached: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  costReported: 0, costEstimated: 0, unknownCostOps: 0, vetted: 0, bugs: 0,
})

const OPENCODE = {
  implementer: 'opencode' as const, model: 'openai/gpt-6.1-sol',
  usage: { uncached: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, usageSource: 'relay' as const,
  cost: 0, costSource: 'reported' as const,
}
const DAY_RUNS = [
  run('r1', OPENCODE),
  run('r2', OPENCODE),
  run('r3', { implementer: 'claude', model: 'claude-haiku-5-5', status: 'failed' }),
]

test('two done opencode runs and one failed claude run make two buckets with the right counters', () => {
  const day = recordFromLedger(ledgerOf(DAY_RUNS)).days['2026-10-09']!
  expect(Object.keys(day).sort()).toEqual(['claude|claude-haiku-5-5', 'opencode|openai/gpt-6.1-sol'])
  const oc = day['opencode|openai/gpt-6.1-sol']!
  expect(oc.ops).toBe(2)
  expect(oc.done).toBe(2)
  expect(oc.uncached).toBe(200)
  expect(oc.costReported).toBe(0)
  const cl = day['claude|claude-haiku-5-5']!
  expect(cl.ops).toBe(1)
  expect(cl.failed).toBe(1)
})

test('recordFromLedger twice on the same ledger is deep-equal', () => {
  const l = ledgerOf(DAY_RUNS)
  expect(recordFromLedger(l)).toEqual(recordFromLedger(l))
})

test('aggregate over a September and an October record counts only the October bucket', () => {
  const sept: HistoryRecord = recordFromLedger(ledgerOf([run('o1', { endedAt: Date.UTC(2026, 8, 1, 11) })]))
  const oct: HistoryRecord = recordFromLedger(ledgerOf(DAY_RUNS))
  const rows = aggregateHistory([sept, oct], Date.UTC(2026, 9, 9))
  expect(rows.length).toBe(2)
  expect(rows.reduce((n, r) => n + r.ops, 0)).toBe(3)
})

test('pruning 205 records keeps the newest 200 and lists 5 in drop', () => {
  const records: Record<string, HistoryRecord> = {}
  for (let i = 0; i < 205; i++) {
    records[`s${i}`] = { v: 1, sessionStartedAt: Date.UTC(2026, 9, 9) + i, days: { '2026-10-09': { 'opencode|m': counters() } } }
  }
  const { keep, drop } = pruneHistory(records, Date.UTC(2026, 9, 9, 12))
  expect(Object.keys(keep).length).toBe(200)
  expect(drop.sort()).toEqual(['s0', 's1', 's2', 's3', 's4'])
})

test('a record whose only day is 40 days old is dropped', () => {
  const old: HistoryRecord = { v: 1, sessionStartedAt: Date.UTC(2026, 7, 30), days: { '2026-08-30': { 'opencode|m': counters() } } }
  const { keep, drop } = pruneHistory({ old }, Date.UTC(2026, 9, 9))
  expect(keep['old']).toBeUndefined()
  expect(drop).toEqual(['old'])
})

test('utcDay uses the UTC calendar day', () => {
  expect(utcDay(Date.UTC(2026, 9, 9, 23, 59))).toBe('2026-10-09')
})

test('usageOps and costOps count only the runs whose usage and cost are known', () => {
  const known = run('k1', OPENCODE)
  const unknown = run('k2', { implementer: 'opencode', model: 'openai/gpt-6.1-sol' })
  const l = ledgerOf([known, unknown])
  const bucket = recordFromLedger(l).days['2026-10-09']!['opencode|openai/gpt-6.1-sol']!
  expect(bucket.ops).toBe(2)
  expect(bucket.usageOps).toBe(1)
  expect(bucket.costOps).toBe(1)
  const row = stationRowsFromLedger(l)[0]!
  expect(row.usageOps).toBe(1)
  expect(row.costOps).toBe(1)
})

test('a history record written without usageOps and costOps reads them as ops when tokens and cost were recorded', () => {
  // the legacy fixture now carries tokens and cost: an all-zero bucket no longer counts as measured (see the next test)
  const old: HistoryRecord = {
    v: 1, sessionStartedAt: Date.UTC(2026, 9, 9),
    days: { '2026-10-09': { 'opencode|m': { ...counters(), uncached: 100, costReported: 0.5 } } },
  }
  const fresh: HistoryRecord = recordFromLedger(ledgerOf([run('f1', OPENCODE), run('f2', {})]))
  const rows = aggregateHistory([old, fresh], Date.UTC(2026, 9, 9, 12))
  const oc = rows.find(r => r.model === 'm')!
  expect(oc.ops).toBe(1)
  expect(oc.usageOps).toBe(1)
  expect(oc.costOps).toBe(1)
  const mixed = rows.find(r => r.model === 'openai/gpt-6.1-sol')!
  expect(mixed.ops).toBe(1)
  expect(mixed.usageOps).toBe(1)
})

test('a legacy raw-CLI record with all-zero tokens and cost reads usageOps and costOps as 0', () => {
  const legacy: HistoryRecord = { v: 1, sessionStartedAt: Date.UTC(2026, 9, 9), days: { '2026-10-09': { 'gemini|g': counters() } } }
  const row = aggregateHistory([legacy], Date.UTC(2026, 9, 9, 12)).find(r => r.model === 'g')!
  expect(row.ops).toBe(1)
  expect(row.usageOps).toBe(0)
  expect(row.costOps).toBe(0)
})

test('unknownCostOps skips relays that can never report a cost', () => {
  const unknown = (over: Partial<Run>): number =>
    recordFromLedger(ledgerOf([run('u1', { model: 'm', ...over })])).days['2026-10-09']![`${over.implementer}|m`]!.unknownCostOps
  expect(unknown({ implementer: 'codex', outDir: '/tmp/out' })).toBe(0)
  expect(unknown({ implementer: 'claude' })).toBe(0)
  expect(unknown({ implementer: 'claude', outDir: '/tmp/out' })).toBe(1)
  expect(unknown({ implementer: 'claude', kind: 'agent' })).toBe(1)
})

test('addRunsToDays adds to a copy: the input days are not changed', () => {
  const days = addRunsToDays({}, [run('d1', OPENCODE)])
  const frozen = JSON.stringify(days)
  const more = addRunsToDays(days, [run('d2', OPENCODE), run('d3', { endedAt: Date.UTC(2026, 9, 10, 1), implementer: 'claude', model: 'm' })])
  expect(JSON.stringify(days)).toBe(frozen)
  expect(more['2026-10-09']!['opencode|openai/gpt-6.1-sol']!.ops).toBe(2)
  expect(more['2026-10-10']!['claude|m']!.ops).toBe(1)
})

const SHARED = { ...OPENCODE, usageSource: 'stats' as const, cost: 1.5, sharedKey: 'oc|/w', sharedSize: 3 }

test('a shared group adds every member as an op on its own end day, and its spend once on the first member\'s day', () => {
  const next = Date.UTC(2026, 9, 10, 1)
  const days = addRunsToDays({}, [run('s1', SHARED), run('s2', { ...SHARED, endedAt: next }), run('s3', SHARED)])
  const first = days['2026-10-09']!['opencode|openai/gpt-6.1-sol']!
  expect(first.ops).toBe(2)
  expect(first.uncached).toBe(100)
  expect(first.costReported).toBe(1.5)
  expect(first.usageOps).toBe(1)
  expect(first.costOps).toBe(1)
  const later = days['2026-10-10']!['opencode|openai/gpt-6.1-sol']!
  expect(later.ops).toBe(1)
  expect(later.done).toBe(1)
  expect(later.uncached).toBe(0)
  expect(later.costReported).toBe(0)
  expect(later.usageOps).toBe(0)
  expect(later.costOps).toBe(0)
})

test('each member of a shared group keeps its own status, review and bugs; only spend and unknown-cost marks are taken once', () => {
  const group = { kind: 'agent' as const, implementer: 'claude' as const, model: 'm', sharedKey: 'k', sharedSize: 3 }
  const review = { reviewerId: 'hq', bugs: 2, edits: 1, source: 'verdict' as const, at: 1 }
  const days = addRunsToDays({}, [
    run('g1', { ...group, status: 'done' }),
    run('g2', { ...group, status: 'failed', reviews: [review], bugsReported: 3 }),
    run('g3', { ...group, status: 'killed' }),
  ])
  const c = days['2026-10-09']!['claude|m']!
  expect([c.ops, c.done, c.failed, c.killed]).toEqual([3, 1, 1, 1])
  expect([c.vetted, c.bugs]).toEqual([1, 5])
  expect(c.unknownCostOps).toBe(1)
})

test('shared groups count their spend once and every member as an op on the live station rows, with the record shape unchanged', () => {
  const ledger = ledgerOf([run('s1', SHARED), run('s2', SHARED), run('o1', OPENCODE)])
  const rows = stationRowsFromLedger(ledger)
  expect(rows.length).toBe(1)
  expect(rows[0]!.ops).toBe(3)
  expect(rows[0]!.uncached).toBe(200)
  expect(rows[0]!.usageOps).toBe(2)
  expect(Object.keys(recordFromLedger(ledger)).sort()).toEqual(['days', 'sessionStartedAt', 'v'])
})

test('a run with child rows adds its spend to the rows implementer × model and its op to its own', () => {
  const child = run('c1', {
    kind: 'cli', implementer: 'claude', model: 'claude-opus-5-5', usageSource: 'child',
    usage: { uncached: 150, output: 10, cacheRead: 0, cacheWrite: 0 }, cost: 2.5, costSource: 'estimated',
    rows: [
      { implementer: 'claude', model: 'claude-opus-5-5', usage: { uncached: 100, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: 2, costSource: 'estimated' },
      { implementer: 'opencode', model: 'openai/gpt-6.1-sol', usage: { uncached: 50, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: 0.5, costSource: 'reported' },
    ],
  })
  const bucket = recordFromLedger(ledgerOf([child])).days['2026-10-09']!
  expect(Object.keys(bucket).sort()).toEqual(['claude|claude-opus-5-5', 'opencode|openai/gpt-6.1-sol'])
  expect(bucket['claude|claude-opus-5-5']!.ops).toBe(1)
  expect(bucket['claude|claude-opus-5-5']!.uncached).toBe(100)
  expect(bucket['claude|claude-opus-5-5']!.costEstimated).toBe(2)
  expect(bucket['opencode|openai/gpt-6.1-sol']!.ops).toBe(0)
  expect(bucket['opencode|openai/gpt-6.1-sol']!.uncached).toBe(50)
  expect(bucket['opencode|openai/gpt-6.1-sol']!.costReported).toBe(0.5)
  expect(stationRowsFromLedger(ledgerOf([child])).length).toBe(2)
})

test('a shared group still held elsewhere adds its members ops to the days but not its spend', () => {
  const member = (id: string) => run(id, { ...SHARED, sharedKey: 'k' })
  const held = addRunsToDays({}, [member('a'), member('b')], new Set(['k']))
  const day = Object.values(held)[0]!['opencode|openai/gpt-6.1-sol']!
  expect(day.ops).toBe(2)
  expect(day.uncached).toBe(0)
  expect(day.costReported).toBe(0)
  // without the hold the group's spend counts once
  const whole = Object.values(addRunsToDays({}, [member('a'), member('b')]))[0]!['opencode|openai/gpt-6.1-sol']!
  expect(whole.ops).toBe(2)
  expect(whole.uncached).toBe(100)
  expect(whole.costReported).toBe(1.5)
})
