import type { HistoryRecord, Implementer, Ledger, Run, StationRow } from '../types'

import { shownCost, storedCost, type Pricing, type Shown } from './cost'

// Pure per-session history (spec §5): a session's record is rebuilt from its
// ledger, the 30-day board is an aggregate of records, pruning is a pure plan.

export const HISTORY_PREFIX = 'history/v1/' as const
export const HISTORY_DAYS = 30 as const
export const HISTORY_MAX_RECORDS = 200 as const

const DAY_MS = 86_400_000

type Counters = Omit<StationRow, 'implementer' | 'model'>

const COUNTER_KEYS: ReadonlyArray<keyof Counters> = [
  'ops', 'done', 'failed', 'killed', 'ended', 'uncached', 'output', 'cacheRead', 'cacheWrite',
  'costReported', 'costEstimated', 'unknownCostOps', 'usageOps', 'costOps', 'vetted', 'bugs',
]

function emptyCounters(): Counters {
  return {
    ops: 0, done: 0, failed: 0, killed: 0, ended: 0, uncached: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    costReported: 0, costEstimated: 0, unknownCostOps: 0, usageOps: 0, costOps: 0, vetted: 0, bugs: 0,
  }
}

/** UTC calendar day, `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
  if (!Number.isFinite(ms)) return '1970-01-01'
  return new Date(ms).toISOString().slice(0, 10)
}

/** What a run or row counts as spending: the cost a sink shows under `pricing` (src/cost.ts), else the stored one. */
function shownOf(c: Parameters<typeof shownCost>[0], pricing: Pricing | undefined): Shown {
  return pricing ? shownCost(c, pricing.mode, pricing.table, pricing.fetched) : storedCost(c)
}

/**
 * `own` false: the run's tokens and cost are not added here (they land on its rows' buckets, a Claude child).
 * Its op, status, reviews and bugs always are.
 */
function addRun(c: Counters, run: Run, pricing: Pricing | undefined, own = true): void {
  const shown = shownOf(run, pricing)
  c.ops += 1
  if (run.status === 'done') c.done += 1
  else if (run.status === 'failed') c.failed += 1
  else if (run.status === 'killed') c.killed += 1
  else if (run.status === 'ended') c.ended += 1
  if (own && run.usage) {
    c.usageOps += 1
    c.uncached += run.usage.uncached
    c.output += run.usage.output
    c.cacheRead += run.usage.cacheRead
    c.cacheWrite += run.usage.cacheWrite
  }
  if (own && shown.cost !== null) c.costOps += 1
  if (own && shown.cost !== null && shown.source === 'reported') c.costReported += shown.cost
  else if (own && shown.cost !== null && shown.source === 'estimated') c.costEstimated += shown.cost
  else if (shown.cost === null && (run.kind === 'agent' || (run.kind === 'relay' && run.implementer !== 'codex' && run.outDir !== undefined))) {
    // a codex relay, or one without an out dir, can never report a cost (as in runCost)
    c.unknownCostOps += 1
  }
  if (run.reviews.length > 0) c.vetted += 1
  c.bugs += run.bugsReported
  for (const review of run.reviews) c.bugs += review.bugs ?? 0
}

function bucketKey(run: Run): string {
  return `${run.implementer}|${run.model ?? '—'}`
}

/** One breakdown row of a Claude child: its spend only, no op (the run's op is counted once, on the run's own bucket). */
function addRow(c: Counters, row: NonNullable<Run['rows']>[number], pricing: Pricing | undefined): void {
  const shown = shownOf(row, pricing)
  c.usageOps += 1
  c.uncached += row.usage.uncached
  c.output += row.usage.output
  c.cacheRead += row.usage.cacheRead
  c.cacheWrite += row.usage.cacheWrite
  if (shown.cost !== null) c.costOps += 1
  if (shown.cost !== null && shown.source === 'reported') c.costReported += shown.cost
  else if (shown.cost !== null && shown.source === 'estimated') c.costEstimated += shown.cost
}

/**
 * Adds one run to its bucket, or a run with child rows to the buckets of its rows: the run's own op stays
 * on its own implementer × model.
 */
function addToBuckets(bucketOf: (key: string) => Counters, run: Run, pricing: Pricing | undefined): void {
  const rows = run.rows
  if (rows === undefined || rows.length === 0) addRun(bucketOf(bucketKey(run)), run, pricing)
  else {
    addRun(bucketOf(bucketKey(run)), run, pricing, false)
    for (const row of rows) addRow(bucketOf(`${row.implementer}|${row.model}`), row, pricing)
  }
}

function orderedRuns(ledger: Ledger): Run[] {
  const runs: Run[] = []
  for (const id of ledger.order) {
    const run = ledger.runs[id]
    if (run) runs.push(run)
  }
  return runs
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function rowsFromBuckets(buckets: ReadonlyMap<string, Counters>): StationRow[] {
  const rows: StationRow[] = []
  for (const [key, c] of buckets) {
    const cut = key.indexOf('|')
    rows.push({ implementer: key.slice(0, cut) as Implementer, model: key.slice(cut + 1), ...c })
  }
  return rows.sort(
    (a, b) =>
      b.costReported + b.costEstimated - (a.costReported + a.costEstimated) ||
      b.ops - a.ops ||
      (a.implementer + '|' + a.model < b.implementer + '|' + b.model ? -1 : 1),
  )
}

/** A copy of `days` without the day buckets older than the 30-day window ending at `nowMs`. */
export function dropOldDays(days: HistoryRecord['days'], nowMs: number): HistoryRecord['days'] {
  const cutoff = utcDay(nowMs - HISTORY_DAYS * DAY_MS)
  const out: HistoryRecord['days'] = {}
  for (const [day, byKey] of Object.entries(days)) if (day >= cutoff) out[day] = byKey
  return out
}

/**
 * A copy of `days` with every run added by its UTC end day and implementer × model bucket; the input is not changed.
 * With `pricing` a bucket takes the cost the run shows (and its source), else the stored one.
 */
export function addRunsToDays(days: HistoryRecord['days'], runs: readonly Run[], pricing?: Pricing): HistoryRecord['days'] {
  const out: HistoryRecord['days'] = {}
  for (const [day, byKey] of Object.entries(days)) {
    const bucket: HistoryRecord['days'][string] = {}
    for (const [key, counters] of Object.entries(byKey)) bucket[key] = { ...emptyCounters(), ...counters }
    out[day] = bucket
  }
  for (const run of runs) {
    const bucket = (out[utcDay(run.endedAt ?? run.startedAt)] ??= {})
    addToBuckets(key => (bucket[key] ??= emptyCounters()) as Counters, run, pricing)
  }
  return out
}

/** The session's whole record, rebuilt from the ledger (idempotent): runs /clear retired plus the live ones. HQ and overhead are excluded. */
export function recordFromLedger(ledger: Ledger, pricing?: Pricing): HistoryRecord {
  return { v: 1, sessionStartedAt: ledger.sessionStartedAt, days: addRunsToDays(ledger.retired ?? {}, orderedRuns(ledger), pricing) }
}

/** Station rows for the live session (all runs, no day split). */
export function stationRowsFromLedger(ledger: Ledger, pricing?: Pricing): StationRow[] {
  const buckets = new Map<string, Counters>()
  const bucketOf = (key: string): Counters => {
    let c = buckets.get(key)
    if (!c) buckets.set(key, (c = emptyCounters()))
    return c
  }
  for (const run of orderedRuns(ledger)) addToBuckets(bucketOf, run, pricing)
  return rowsFromBuckets(buckets)
}

/** Sums every day bucket from the last 30 days into one row per implementer × model. */
export function aggregateHistory(records: readonly HistoryRecord[], nowMs: number): StationRow[] {
  const cutoff = utcDay(nowMs - HISTORY_DAYS * DAY_MS)
  const buckets = new Map<string, Counters>()
  for (const record of records) {
    for (const [day, byKey] of Object.entries(record.days)) {
      if (day < cutoff) continue
      for (const [key, counters] of Object.entries(byKey)) {
        if (key.indexOf('|') < 0) continue
        let c = buckets.get(key)
        if (!c) buckets.set(key, (c = emptyCounters()))
        for (const k of COUNTER_KEYS) c[k] += num(counters[k])
        // a record written before usageOps / costOps existed: its ops count as measured only when
        // the bucket carries any tokens or cost (an all-zero bucket is raw-CLI ops with no measurement)
        if (counters.usageOps === undefined && num(counters.uncached) + num(counters.output) + num(counters.cacheRead) + num(counters.cacheWrite) > 0) {
          c.usageOps += num(counters.ops)
        }
        if (counters.costOps === undefined && num(counters.costReported) + num(counters.costEstimated) > 0) c.costOps += num(counters.ops)
      }
    }
  }
  return rowsFromBuckets(buckets)
}

/** Plans pruning: old day buckets go, empty records go, then the newest 200 stay. */
export function pruneHistory(
  records: Readonly<Record<string, HistoryRecord>>,
  nowMs: number,
): { keep: Record<string, HistoryRecord>; drop: string[] } {
  const cutoff = utcDay(nowMs - HISTORY_DAYS * DAY_MS)
  const drop: string[] = []
  const live: Array<[string, HistoryRecord]> = []
  for (const [id, record] of Object.entries(records)) {
    const days: HistoryRecord['days'] = {}
    for (const [day, byKey] of Object.entries(record.days)) {
      if (day >= cutoff) days[day] = byKey
    }
    if (Object.keys(days).length === 0) drop.push(id)
    else live.push([id, { ...record, days }])
  }
  live.sort((a, b) => b[1].sessionStartedAt - a[1].sessionStartedAt || (a[0] < b[0] ? -1 : 1))
  const keep: Record<string, HistoryRecord> = {}
  live.forEach(([id, record], i) => {
    if (i < HISTORY_MAX_RECORDS) keep[id] = record
    else drop.push(id)
  })
  return { keep, drop }
}
