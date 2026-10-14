import type { Implementer, Ledger, Run, Usage } from '../../types'
import { fingerprint } from '../collect/relay'
import { shownCost, storedCost, type Pricing } from '../cost'
import { aggregateHistory, stationRowsFromLedger } from '../history'
import { ident } from '../relay-result'
import { exceedsBytes } from './opencode-stats'

// Pure side of the Claude child report (spec §4): a child builds a numbers-only JSON report of its whole
// spend, the parent projects a report file through an allow-list and matches it to one of its runs.
// Values are read by name only: nothing parsed is iterated or stringified, so nothing else can leave here.

export const CHILD_SCHEMA = 'watchducks.child.v1'
export const CHILD_DIR = 'watchducks-children'
/** A child id is a file name: letters, digits, `_` and `-` only. */
export const CHILD_ID = /^[A-Za-z0-9_-]{1,128}$/
export const MAX_REPORT_BYTES = 65_536
export const MAX_ROWS = 32
export const REPORT_EVERY_MS = 5000
export const STALE_MS = 86_400_000
export const READ_EVERY_MS = 3000
export const MAX_REPORTS_LISTED = 256

/** A report starts this long before, and this long after, the Bash call that started the child (spec §4.6). */
const MATCH_BEFORE_MS = 5000
const MATCH_AFTER_MS = 60_000

const MAX_COUNT = 1e12
const MAX_COST = 1e6
const MAX_MODEL = 80
const MAX_STAMP = 40
const UNKNOWN_MODEL = 'unknown'
/** The row a folded group of rows becomes when the report holds more than MAX_ROWS. */
const OTHER_MODEL = 'other'
/** A run's model counts for matching only when it names a full model (`claude-sonnet-5-5`), not an alias such as `sonnet`. */
const FULL_MODEL = 'claude-'
const WORKDIR_KEY = /^[0-9a-z]{1,16}$/
const IMPLEMENTERS: ReadonlySet<string> = new Set<Implementer>(['claude-code', 'claude', 'opencode', 'codex', 'gemini', 'shell', 'unknown'])

type Row = NonNullable<Run['rows']>[number]

export type ChildReport = {
  startedAt: number
  updatedAt: number
  workdirKey?: string
  /** The model of the child's own requests, when the report says so (otherwise the largest `claude-code` row stands for it). */
  hqModel?: string
  status: 'running' | 'done' | 'failed'
  rows: NonNullable<Run['rows']>
}

/** `${tmpRoot}/watchducks-children/<fingerprint of the parent's session id>`: only the hash names the parent. */
export function reportDir(tmpRoot: string, parentSessionId: string): string {
  return `${tmpRoot.replace(/\/+$/, '')}/${CHILD_DIR}/${fingerprint(parentSessionId)}`
}

function count(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_COUNT) : 0
}

function usageOf(u: Usage): Usage {
  return { uncached: count(u.uncached), output: count(u.output), cacheRead: count(u.cacheRead), cacheWrite: count(u.cacheWrite) }
}

function tokensOf(u: Usage): number {
  return u.uncached + u.output + u.cacheRead + u.cacheWrite
}

/** A model name the parent's projection accepts: invalid characters become `_`, a missing model (`—`) becomes `unknown`. */
function modelName(model: string): string {
  const name = model.replace(/[^A-Za-z0-9._:/#@+~-]/g, '_').slice(0, MAX_MODEL)
  return name === '' || name === '—' ? UNKNOWN_MODEL : name
}

function stampText(ms: number): string {
  return new Date(Number.isFinite(ms) ? ms : 0).toISOString()
}

/** Folds one more row into the merged map: usage and cost add, a cost is `reported` only while every contributing cost is. */
function mergeRow(rows: Map<string, Row>, row: Row): void {
  const key = `${row.implementer}|${row.model}`
  const had = rows.get(key)
  if (had === undefined) {
    rows.set(key, row)
    return
  }
  const cost = had.cost === null ? row.cost : row.cost === null ? had.cost : had.cost + row.cost
  const costed = [had, row].filter(r => r.cost !== null)
  const costSource = cost === null ? null : costed.every(r => r.costSource === 'reported') ? 'reported' : 'estimated'
  rows.set(key, {
    implementer: row.implementer,
    model: row.model,
    usage: {
      uncached: had.usage.uncached + row.usage.uncached,
      output: had.usage.output + row.usage.output,
      cacheRead: had.usage.cacheRead + row.usage.cacheRead,
      cacheWrite: had.usage.cacheWrite + row.usage.cacheWrite,
    },
    cost,
    costSource,
  })
}

/**
 * The rows of a report: the largest by tokens, and when there are more than MAX_ROWS the rest folded into one
 * `{ implementer, model: 'other' }` row per implementer among the folded ones, so the total stays within MAX_ROWS rows and
 * no usage or cost is lost.
 */
function capRows(merged: ReadonlyMap<string, Row>): Row[] {
  const sorted = [...merged.values()].sort(
    (a, b) => tokensOf(b.usage) - tokensOf(a.usage) || (`${a.implementer}|${a.model}` < `${b.implementer}|${b.model}` ? -1 : 1),
  )
  for (let keep = Math.min(sorted.length, MAX_ROWS); keep >= 0; keep--) {
    const rows = new Map<string, Row>()
    for (const row of sorted.slice(0, keep)) rows.set(`${row.implementer}|${row.model}`, row)
    for (const row of sorted.slice(keep)) mergeRow(rows, { ...row, model: OTHER_MODEL })
    if (rows.size <= MAX_ROWS) {
      return [...rows.values()].sort(
        (a, b) => tokensOf(b.usage) - tokensOf(a.usage) || (`${a.implementer}|${a.model}` < `${b.implementer}|${b.model}` ? -1 : 1),
      )
    }
  }
  return sorted.slice(0, MAX_ROWS)
}

/** The model of the main loop's requests: the one with the most tokens among `hqByModel` (the overflow bucket aside). */
function hqModelOf(ledger: Ledger): string | undefined {
  let best: string | undefined
  let most = -1
  for (const [model, spend] of Object.entries(ledger.hqByModel ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (model === OTHER_MODEL) continue
    const tokens = tokensOf(usageOf(spend.usage))
    if (tokens > most) {
      most = tokens
      best = modelName(model)
    }
  }
  return best
}

/**
 * The JSON text of this session's report: its whole spend by implementer × model and nothing else. The rows are the main
 * loop's spend by model (implementer `claude-code`) plus the station board's rows of the ledger (the board's own spend
 * rules: a shared group once, a run with child rows contributing those) and the spend /flock clear retired, merged; past
 * MAX_ROWS the smallest fold into `other` rows. `hqModel` names the model of the main loop's own requests. With `pricing` the
 * costs are the ones this session shows (cost mode and price table), else the stored ones.
 */
export function buildReport(
  ledger: Ledger,
  startedAt: number,
  workdirKey: string | undefined,
  status: ChildReport['status'],
  now: number,
  pricing?: Pricing,
): string {
  const merged = new Map<string, Row>()
  for (const [model, spend] of Object.entries(ledger.hqByModel ?? {})) {
    const usage = usageOf(spend.usage)
    // what the child shows: the cost under its own cost mode (the parent adds the rows up as they come)
    const row = { cost: spend.cost, costSource: spend.cost === null ? null : ('estimated' as const), usage: spend.usage, model }
    const shown = pricing ? shownCost(row, pricing.mode, pricing.table, pricing.fetched) : storedCost(row)
    const cost = shown.cost !== null && Number.isFinite(shown.cost) ? Math.min(Math.max(shown.cost, 0), MAX_COST) : null
    mergeRow(merged, { implementer: 'claude-code', model: modelName(model), usage, cost, costSource: cost === null ? null : (shown.source ?? 'estimated') })
  }
  const retired = aggregateHistory([{ v: 1, sessionStartedAt: ledger.sessionStartedAt, days: ledger.retired ?? {} }], now)
  for (const s of [...stationRowsFromLedger(ledger, pricing), ...retired]) {
    // a bucket of runs that measured nothing carries no spend
    if (s.usageOps === 0 && s.costOps === 0) continue
    const total = s.costReported + s.costEstimated
    const cost = s.costOps > 0 && Number.isFinite(total) ? Math.min(Math.max(total, 0), MAX_COST) : null
    const costSource = cost === null ? null : s.costEstimated > 0 ? 'estimated' : 'reported'
    const usage = usageOf({ uncached: s.uncached, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite })
    mergeRow(merged, { implementer: s.implementer, model: modelName(s.model), usage, cost, costSource })
  }
  const hqModel = hqModelOf(ledger)
  return JSON.stringify({
    schema: CHILD_SCHEMA,
    startedAt: stampText(startedAt),
    updatedAt: stampText(now),
    ...(workdirKey !== undefined ? { workdirKey } : {}),
    ...(hqModel !== undefined ? { hqModel } : {}),
    status,
    rows: capRows(merged),
  })
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function bounded(v: unknown, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined
}

function stamp(v: unknown): number | undefined {
  if (typeof v !== 'string' || v.length > MAX_STAMP) return undefined
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? undefined : ms
}

function projectUsage(v: unknown): Usage | undefined {
  if (!isObject(v)) return undefined
  const uncached = bounded(v['uncached'], MAX_COUNT)
  const output = bounded(v['output'], MAX_COUNT)
  const cacheRead = bounded(v['cacheRead'], MAX_COUNT)
  const cacheWrite = bounded(v['cacheWrite'], MAX_COUNT)
  if (uncached === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined
  return { uncached, output, cacheRead, cacheWrite }
}

function projectRow(v: unknown): Row | undefined {
  if (!isObject(v)) return undefined
  const implementer = v['implementer']
  if (typeof implementer !== 'string' || !IMPLEMENTERS.has(implementer)) return undefined
  const model = ident(v['model'])
  const usage = projectUsage(v['usage'])
  if (model === undefined || usage === undefined) return undefined
  const rawCost = v['cost']
  const source = v['costSource']
  if (rawCost === null) {
    if (source !== null) return undefined
    return { implementer: implementer as Implementer, model, usage, cost: null, costSource: null }
  }
  const cost = bounded(rawCost, MAX_COST)
  if (cost === undefined || (source !== 'reported' && source !== 'estimated')) return undefined
  return { implementer: implementer as Implementer, model, usage, cost, costSource: source }
}

/** Null when the text is too large, not JSON, not this schema, malformed in any allow-listed field, over 32 rows, or stale. */
export function projectReport(text: string, now: number): ChildReport | null {
  if (typeof text !== 'string' || exceedsBytes(text, MAX_REPORT_BYTES)) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(raw) || raw['schema'] !== CHILD_SCHEMA) return null
  const startedAt = stamp(raw['startedAt'])
  const updatedAt = stamp(raw['updatedAt'])
  if (startedAt === undefined || updatedAt === undefined || now - updatedAt > STALE_MS) return null
  const status = raw['status']
  if (status !== 'running' && status !== 'done' && status !== 'failed') return null
  const key = raw['workdirKey']
  if (key !== undefined && (typeof key !== 'string' || !WORKDIR_KEY.test(key))) return null
  const hq = raw['hqModel']
  const hqModel = hq === undefined ? undefined : ident(hq)
  if (hq !== undefined && hqModel === undefined) return null
  const list = raw['rows']
  if (!Array.isArray(list) || list.length > MAX_ROWS) return null
  const rows: Row[] = []
  for (const item of list) {
    const row = projectRow(item)
    if (row === undefined) return null
    rows.push(row)
  }
  return { startedAt, updatedAt, ...(key !== undefined ? { workdirKey: key } : {}), ...(hqModel !== undefined ? { hqModel } : {}), status, rows }
}

/** The model of the child's own requests: the report's `hqModel`, else its `claude-code` row with the most tokens (the first of equals). */
export function mainModel(r: ChildReport): string | undefined {
  if (r.hqModel !== undefined) return r.hqModel
  let best: string | undefined
  let most = -1
  for (const row of r.rows) {
    if (row.implementer !== 'claude-code') continue
    const tokens = tokensOf(row.usage)
    if (tokens > most) {
      most = tokens
      best = row.model
    }
  }
  return best
}

/**
 * Pairs runs with reports (spec §4.6): the report started from 5 s before to 60 s after the run (edges included), its
 * folder and main model equal the run's when the run knows them (a report that does not say counts as different; a model
 * counts as known only when it is a full id, `claude-…`, not an alias such as `sonnet`), the
 * earliest run takes the earliest report, one each. Reports in `claimed` (by file) are skipped. Inputs are not changed.
 */
export function matchReports(
  runs: readonly Run[],
  reports: ReadonlyArray<{ file: string; report: ChildReport }>,
  claimed: ReadonlySet<string>,
): Array<{ id: string; file: string }> {
  const ordered = [...runs].sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const free = reports
    .filter(r => !claimed.has(r.file))
    .sort((a, b) => a.report.startedAt - b.report.startedAt || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  const taken = new Set<string>()
  const out: Array<{ id: string; file: string }> = []
  for (const run of ordered) {
    const hit = free.find(({ file, report }) => {
      if (taken.has(file)) return false
      const lag = report.startedAt - run.startedAt
      if (lag < -MATCH_BEFORE_MS || lag > MATCH_AFTER_MS) return false
      if (run.workdirKey !== undefined && report.workdirKey !== run.workdirKey) return false
      // an alias (`sonnet`) or any other name that is not a full model id says nothing about the report's model
      return run.model === undefined || !run.model.startsWith(FULL_MODEL) || mainModel(report) === run.model
    })
    if (hit === undefined) continue
    taken.add(hit.file)
    out.push({ id: run.id, file: hit.file })
  }
  return out
}

/**
 * What a report gives its run (spec §4.6): usage is the sum of the rows. The cost is the sum of the rows that have one (a
 * report with some rows unpriced still shows what is known; the ledger marks the run partial from the rows themselves); null
 * and a null source when no row has one. The source is `reported` only while every costed row's is, else `estimated`.
 */
export function reportUsage(r: ChildReport): { usage: Usage; cost: number | null; costSource: 'reported' | 'estimated' | null } {
  let usage: Usage = { uncached: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let cost: number | null = null
  let costSource: 'reported' | 'estimated' | null = null
  for (const row of r.rows) {
    usage = {
      uncached: usage.uncached + row.usage.uncached,
      output: usage.output + row.usage.output,
      cacheRead: usage.cacheRead + row.usage.cacheRead,
      cacheWrite: usage.cacheWrite + row.usage.cacheWrite,
    }
    if (row.cost === null) continue
    cost = (cost ?? 0) + row.cost
    costSource = costSource === null ? row.costSource : costSource === 'reported' && row.costSource === 'reported' ? 'reported' : 'estimated'
  }
  return { usage, cost, costSource }
}
