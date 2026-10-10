import type { HistoryRecord, Implementer, Ledger, Run, StationRow } from '../types'

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

function addRun(c: Counters, run: Run): void {
  c.ops += 1
  if (run.status === 'done') c.done += 1
  else if (run.status === 'failed') c.failed += 1
  else if (run.status === 'killed') c.killed += 1
  else if (run.status === 'ended') c.ended += 1
  if (run.usage) {
    c.usageOps += 1
    c.uncached += run.usage.uncached
    c.output += run.usage.output
    c.cacheRead += run.usage.cacheRead
    c.cacheWrite += run.usage.cacheWrite
  }
  if (run.cost !== null) c.costOps += 1
  if (run.cost !== null && run.costSource === 'reported') c.costReported += run.cost
  else if (run.cost !== null && run.costSource === 'estimated') c.costEstimated += run.cost
  else if (run.cost === null && (run.kind === 'agent' || run.kind === 'relay')) c.unknownCostOps += 1
  if (run.reviews.length > 0) c.vetted += 1
  c.bugs += run.bugsReported
  for (const review of run.reviews) c.bugs += review.bugs ?? 0
}

function bucketKey(run: Run): string {
  return `${run.implementer}|${run.model ?? '—'}`
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

/** A copy of `days` with every run added by its UTC end day and implementer × model bucket; the input is not changed. */
export function addRunsToDays(days: HistoryRecord['days'], runs: readonly Run[]): HistoryRecord['days'] {
  const out: HistoryRecord['days'] = {}
  for (const [day, byKey] of Object.entries(days)) {
    const bucket: HistoryRecord['days'][string] = {}
    for (const [key, counters] of Object.entries(byKey)) bucket[key] = { ...emptyCounters(), ...counters }
    out[day] = bucket
  }
  for (const run of runs) {
    const bucket = (out[utcDay(run.endedAt ?? run.startedAt)] ??= {})
    const key = bucketKey(run)
    const counters = (bucket[key] ??= emptyCounters())
    addRun(counters as Counters, run)
  }
  return out
}

/** The session's whole record, rebuilt from the ledger (idempotent): runs /clear retired plus the live ones. HQ and overhead are excluded. */
export function recordFromLedger(ledger: Ledger): HistoryRecord {
  return { v: 1, sessionStartedAt: ledger.sessionStartedAt, days: addRunsToDays(ledger.retired ?? {}, orderedRuns(ledger)) }
}

/** Station rows for the live session (all runs, no day split). */
export function stationRowsFromLedger(ledger: Ledger): StationRow[] {
  const buckets = new Map<string, Counters>()
  for (const run of orderedRuns(ledger)) {
    const key = bucketKey(run)
    let c = buckets.get(key)
    if (!c) buckets.set(key, (c = emptyCounters()))
    addRun(c, run)
  }
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
        // a record written before usageOps / costOps existed counts every op as known
        for (const k of COUNTER_KEYS) {
          const v = counters[k]
          c[k] += num(v === undefined && (k === 'usageOps' || k === 'costOps') ? counters.ops : v)
        }
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
