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

test('a history record written without usageOps and costOps reads them as ops', () => {
  const old: HistoryRecord = { v: 1, sessionStartedAt: Date.UTC(2026, 9, 9), days: { '2026-10-09': { 'opencode|m': counters() } } }
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

test('addRunsToDays adds to a copy: the input days are not changed', () => {
  const days = addRunsToDays({}, [run('d1', OPENCODE)])
  const frozen = JSON.stringify(days)
  const more = addRunsToDays(days, [run('d2', OPENCODE), run('d3', { endedAt: Date.UTC(2026, 9, 10, 1), implementer: 'claude', model: 'm' })])
  expect(JSON.stringify(days)).toBe(frozen)
  expect(more['2026-10-09']!['opencode|openai/gpt-6.1-sol']!.ops).toBe(2)
  expect(more['2026-10-10']!['claude|m']!.ops).toBe(1)
})
