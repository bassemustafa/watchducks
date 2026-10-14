import type { PluginOptions } from 'claude-code'

import type { HistoryRecord, UiState } from '../types'
import { parseCostMode, type CostMode, type Pricing } from './cost'
import { emptyLedger } from './ledger'
import { PRICES, withOverrides, type PriceTable } from './price'

// The mod's two shared values and pure helpers around them (spec §5, §10).
// Nothing here takes `$` or declares an atom: the engine follows `$` only into functions declared
// in the file that uses it, so every `$` helper lives beside its hook.

export const INITIAL_UI: UiState = { view: 'field', span: 'session', closedByPerson: false, autoOpened: false }

// The engine reads state references off each file's source: a file that reads
// or writes a value declares its own atom from a literal reference, e.g.
//   const ledgerAtom = atom({ plugin: 'watchducks', key: 'ledger' } as const, INITIAL_LEDGER)
export const INITIAL_LEDGER = emptyLedger('', 0)

export function prices(options: PluginOptions): PriceTable {
  const raw = options.priceOverrides
  return withOverrides(PRICES, typeof raw === 'string' ? raw : '')
}

export function costMode(options: PluginOptions): CostMode {
  return parseCostMode(options.costMode)
}

/** The price table and the cost mode every sink prices with. */
export function pricing(options: PluginOptions): Pricing {
  return { table: prices(options), mode: costMode(options) }
}

export function recordsHeadless(options: PluginOptions): boolean {
  return options.recordHeadless === 'on'
}

export function isHistoryRecord(v: unknown): v is HistoryRecord {
  if (typeof v !== 'object' || v === null) return false
  const r = v as { v?: unknown; sessionStartedAt?: unknown; days?: unknown }
  return r.v === 1 && typeof r.sessionStartedAt === 'number' && typeof r.days === 'object' && r.days !== null && !Array.isArray(r.days)
}
