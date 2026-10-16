import type { Ledger, Run, Usage } from '../types'
import { estimateDetail, type LitellmTable, type PriceTable } from './price'

// The cost a sink shows (spec §3.8): one pure function over what the ledger stored, the `costMode` setting and the price
// table. The ledger keeps what sources gave; nothing here is written back.

export type CostMode = 'auto' | 'estimate' | 'reported'

/**
 * What every sink needs to price a run: the effective table, the mode, and the refreshed LiteLLM list with its fetch time
 * when there is one (spec §3.9; the bundled snapshot is the fallback below it).
 */
export type Pricing = { table: PriceTable; mode: CostMode; fetched?: LitellmTable; fetchedAt?: number }

export type CostSource = 'reported' | 'estimated'

export type Shown = {
  cost: number | null
  source: CostSource | null
  /** The source reported $0 although tokens flowed, and the cost shown is an estimate instead. */
  reportedZero?: boolean
  /** Some request or child row of the shown cost has no price (set only when true). */
  partial?: true
  /** The estimate used LiteLLM rates: from the refreshed list or from the list bundled with this version. */
  list?: 'fetched' | 'bundled'
}

/** A run, a child row, or anything shaped like them. */
export type Costed = {
  cost: number | null
  costSource: CostSource | null
  usage: Usage | null
  model?: string
  /** The stored flag: some requests had no price. */
  costPartial?: boolean
  rows?: Run['rows']
}

export function parseCostMode(v: unknown): CostMode {
  return v === 'estimate' || v === 'reported' ? v : 'auto'
}

/** The stored figures as they are: what a sink without pricing shows. */
export function storedCost(c: Pick<Costed, 'cost' | 'costSource' | 'costPartial'>): Shown {
  return { cost: c.cost, source: c.cost === null ? null : c.costSource, ...(c.costPartial ? { partial: true as const } : {}) }
}

const hasTokens = (u: Usage | null): boolean => u !== null && u.uncached + u.output + u.cacheRead + u.cacheWrite > 0

function one(c: Costed, mode: CostMode, table: PriceTable, fetched: LitellmTable | undefined): Shown {
  // an estimate from the tokens, marked with the LiteLLM list it used (none for overrides and the Claude table)
  const priced = (reportedZero = false): Shown | null => {
    const e = c.usage && c.model ? estimateDetail(c.usage, c.model, table, undefined, fetched) : null
    if (e === null) return null
    const s: Shown = { cost: e.cost, source: 'estimated' }
    if (reportedZero) s.reportedZero = true
    if (e.from !== 'table') s.list = e.from
    return s
  }
  if (mode === 'reported') return c.cost !== null && c.costSource === 'reported' ? { cost: c.cost, source: 'reported' } : { cost: null, source: null }
  if (mode === 'estimate') {
    // a stored estimate was priced from tokens already, per request (a run that used several models keeps each one's rate)
    if (c.cost !== null && c.costSource === 'estimated') return storedCost(c)
    return priced() ?? storedCost(c)
  }
  if (c.cost !== null) {
    if (c.costSource === 'estimated' || c.cost > 0 || !hasTokens(c.usage)) return storedCost(c)
    return priced(true) ?? storedCost(c)
  }
  return priced() ?? { cost: null, source: null }
}

/** The list a sum shows: a refreshed list over a bundled one. */
function listOf(had: Shown['list'], s: Shown['list']): Shown['list'] {
  return had === 'fetched' || s === 'fetched' ? 'fetched' : (had ?? s)
}

/** The cost to show for a run or a row; a run with child rows is the sum of its rows, each by the same rule. */
export function shownCost(c: Costed, mode: CostMode, table: PriceTable, fetched?: LitellmTable): Shown {
  const rows = c.rows
  if (rows === undefined || rows.length === 0) return one(c, mode, table, fetched)
  let cost: number | null = null
  let source: CostSource | null = null
  let reportedZero = false
  let partial = false
  let list: Shown['list']
  for (const row of rows) {
    const s = one(row, mode, table, fetched)
    if (s.partial) partial = true
    if (s.cost === null) {
      partial = true
      continue
    }
    cost = (cost ?? 0) + s.cost
    source = source === null ? s.source : source === 'reported' && s.source === 'reported' ? 'reported' : 'estimated'
    if (s.reportedZero) reportedZero = true
    list = listOf(list, s.list)
  }
  const shown: Shown = { cost, source }
  if (reportedZero) shown.reportedZero = true
  if (partial) shown.partial = true
  if (list) shown.list = list
  return shown
}

/** The main loop's spend as a run of rows, one per model (every figure of it is an estimate); a ledger without the split is one row. */
export function shownHq(ledger: Pick<Ledger, 'hq' | 'hqByModel'>, mode: CostMode, table: PriceTable, fetched?: LitellmTable): Shown {
  const models = Object.entries(ledger.hqByModel ?? {})
  const row = (model: string | undefined, s: Ledger['hq']): Costed => ({
    cost: s.cost,
    costSource: s.cost === null ? null : 'estimated',
    costPartial: s.costPartial,
    usage: s.usage,
    ...(model !== undefined ? { model } : {}),
  })
  if (models.length === 0) return shownCost(row(undefined, ledger.hq), mode, table, fetched)
  let cost: number | null = null
  let source: CostSource | null = null
  let partial = false
  for (const [model, spend] of models) {
    const s = shownCost(row(model, spend), mode, table, fetched)
    if (s.partial || s.cost === null) partial = true
    if (s.cost === null) continue
    cost = (cost ?? 0) + s.cost
    source = source === null ? s.source : source === 'reported' && s.source === 'reported' ? 'reported' : 'estimated'
  }
  return { cost, source, ...(partial ? { partial: true as const } : {}) }
}

/** The model of the main loop's requests: the one with the most tokens among `hqByModel` (the overflow `'other'` key aside), ties by name. */
export function hqModelOf(ledger: Pick<Ledger, 'hqByModel'>): string | undefined {
  let best: string | undefined
  let most = -1
  for (const [model, spend] of Object.entries(ledger.hqByModel ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (model === 'other') continue
    const u = spend.usage
    const tokens = u.uncached + u.output + u.cacheRead + u.cacheWrite
    if (tokens > most) {
      most = tokens
      best = model
    }
  }
  return best
}
