import type { Ledger, Run, Usage } from '../types'
import { estimateCost, type PriceTable } from './price'

// The cost a sink shows (spec §3.8): one pure function over what the ledger stored, the `costMode` setting and the price
// table. The ledger keeps what sources gave; nothing here is written back.

export type CostMode = 'auto' | 'calculate' | 'display'

/** What every sink needs to price a run: the effective table and the mode. */
export type Pricing = { table: PriceTable; mode: CostMode }

export type CostSource = 'reported' | 'estimated'

export type Shown = {
  cost: number | null
  source: CostSource | null
  /** The source reported $0 although tokens flowed, and the cost shown is an estimate instead. */
  reportedZero?: boolean
  /** Some request or child row of the shown cost has no price (set only when true). */
  partial?: true
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
  return v === 'calculate' || v === 'display' ? v : 'auto'
}

/** The stored figures as they are: what a sink without pricing shows. */
export function storedCost(c: Pick<Costed, 'cost' | 'costSource' | 'costPartial'>): Shown {
  return { cost: c.cost, source: c.cost === null ? null : c.costSource, ...(c.costPartial ? { partial: true as const } : {}) }
}

const hasTokens = (u: Usage | null): boolean => u !== null && u.uncached + u.output + u.cacheRead + u.cacheWrite > 0

function one(c: Costed, mode: CostMode, table: PriceTable): Shown {
  const estimate = (): number | null => (c.usage && c.model ? estimateCost(c.usage, c.model, table) : null)
  if (mode === 'display') return c.cost !== null && c.costSource === 'reported' ? { cost: c.cost, source: 'reported' } : { cost: null, source: null }
  if (mode === 'calculate') {
    // a stored estimate was priced from tokens already, per request (a run that used several models keeps each one's rate)
    if (c.cost !== null && c.costSource === 'estimated') return storedCost(c)
    const e = estimate()
    return e !== null ? { cost: e, source: 'estimated' } : storedCost(c)
  }
  if (c.cost !== null) {
    if (c.costSource === 'estimated' || c.cost > 0 || !hasTokens(c.usage)) return storedCost(c)
    const e = estimate()
    return e !== null ? { cost: e, source: 'estimated', reportedZero: true } : storedCost(c)
  }
  const e = estimate()
  return e !== null ? { cost: e, source: 'estimated' } : { cost: null, source: null }
}

/** The cost to show for a run or a row; a run with child rows is the sum of its rows, each by the same rule. */
export function shownCost(c: Costed, mode: CostMode, table: PriceTable): Shown {
  const rows = c.rows
  if (rows === undefined || rows.length === 0) return one(c, mode, table)
  let cost: number | null = null
  let source: CostSource | null = null
  let reportedZero = false
  let partial = false
  for (const row of rows) {
    const s = one(row, mode, table)
    if (s.partial) partial = true
    if (s.cost === null) {
      partial = true
      continue
    }
    cost = (cost ?? 0) + s.cost
    source = source === null ? s.source : source === 'reported' && s.source === 'reported' ? 'reported' : 'estimated'
    if (s.reportedZero) reportedZero = true
  }
  return { cost, source, ...(reportedZero ? { reportedZero } : {}), ...(partial ? { partial: true as const } : {}) }
}

/** The main loop's spend as a run of rows, one per model (every figure of it is an estimate); a ledger without the split is one row. */
export function shownHq(ledger: Pick<Ledger, 'hq' | 'hqByModel'>, mode: CostMode, table: PriceTable): Shown {
  const models = Object.entries(ledger.hqByModel ?? {})
  const row = (model: string | undefined, s: Ledger['hq']): Costed => ({
    cost: s.cost,
    costSource: s.cost === null ? null : 'estimated',
    costPartial: s.costPartial,
    usage: s.usage,
    ...(model !== undefined ? { model } : {}),
  })
  if (models.length === 0) return shownCost(row(undefined, ledger.hq), mode, table)
  let cost: number | null = null
  let source: CostSource | null = null
  let partial = false
  for (const [model, spend] of models) {
    const s = shownCost(row(model, spend), mode, table)
    if (s.partial || s.cost === null) partial = true
    if (s.cost === null) continue
    cost = (cost ?? 0) + s.cost
    source = source === null ? s.source : source === 'reported' && s.source === 'reported' ? 'reported' : 'estimated'
  }
  return { cost, source, ...(partial ? { partial: true as const } : {}) }
}
