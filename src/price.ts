import type { Usage } from '../types'

export type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type PriceTable = Record<string, Rates>

export const PRICES_DATE = '2026-10-06' as const

const LONG_TIER_MODEL = 'claude-haiku-5-5'
const LONG_TIER_KEY = 'claude-haiku-5-5@long'
const LONG_TIER_ABOVE = 100_000

// USD per million tokens; cacheWrite is the 5-minute TTL rate (1.25 x input).
export const PRICES: PriceTable = {
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  [LONG_TIER_KEY]: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
}

export const ZERO_USAGE: Usage = { uncached: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export function normalizeModel(id: string): string {
  return id
    .toLowerCase()
    .replace(/\[1m\]$/, '')
    .replace(/^anthropic\./, '')
    .replace(/@.*$/, '')
    .replace(/-\d{8}$/, '')
}

function rowFor(table: PriceTable, key: string): Rates | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

export function ratesFor(model: string, totalInput: number, table: PriceTable): Rates | null {
  const key = normalizeModel(model)
  if (key === LONG_TIER_MODEL && totalInput > LONG_TIER_ABOVE) {
    const long = rowFor(table, LONG_TIER_KEY)
    if (long) return long
  }
  return rowFor(table, key) ?? null
}

export function estimateCost(usage: Usage, model: string, table: PriceTable): number | null {
  const totalInput = usage.uncached + usage.cacheRead + usage.cacheWrite
  const rates = ratesFor(model, totalInput, table)
  if (!rates) return null
  return (
    (usage.uncached * rates.input +
      usage.output * rates.output +
      usage.cacheRead * rates.cacheRead +
      usage.cacheWrite * rates.cacheWrite) /
    1e6
  )
}

function validRate(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

export function withOverrides(table: PriceTable, json: string): PriceTable {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return table
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return table
  const merged: PriceTable = { ...table }
  let base: Rates | undefined
  let longGiven = false
  for (const [rawKey, entry] of Object.entries(parsed)) {
    if (typeof entry !== 'object' || entry === null) continue
    const { input, output, cacheRead, cacheWrite } = entry as Record<string, unknown>
    if (!validRate(input) || !validRate(output) || !validRate(cacheRead) || !validRate(cacheWrite)) continue
    const key = rawKey === LONG_TIER_KEY ? rawKey : normalizeModel(rawKey)
    if (key === '__proto__') continue
    merged[key] = { input, output, cacheRead, cacheWrite }
    if (key === LONG_TIER_KEY) longGiven = true
    else if (key === LONG_TIER_MODEL) base = merged[key]
  }
  // a base override without a valid long-tier one prices both tiers
  if (base && !longGiven) merged[LONG_TIER_KEY] = { ...base }
  return merged
}

export function usageFromApi(u: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}): Usage {
  return {
    uncached: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens,
    cacheWrite: u.cache_creation_input_tokens,
  }
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    uncached: a.uncached + b.uncached,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}
