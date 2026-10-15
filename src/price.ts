import type { Usage } from '../types'
import { exceedsBytes } from './adapters/opencode-stats'
import { LITELLM } from './prices-litellm'

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

/** A LiteLLM snapshot: USD per million tokens `[input, output, cacheRead, cacheWrite]` by lower-cased LiteLLM key. */
export type Rates4 = readonly [number, number, number, number]
export type LitellmTable = Readonly<Record<string, Rates4>>

/** Providers tried, in this order, for a model id that carries none. */
const PROVIDER_ORDER = [
  'openai', 'anthropic', 'gemini', 'vertex_ai', 'xai', 'deepseek', 'mistral', 'groq', 'azure', 'azure_ai', 'openrouter',
  'bedrock', 'together_ai', 'fireworks_ai',
] as const

/** Model-name prefixes and the maker's own LiteLLM provider; the first match wins. */
const MAKERS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/^glm-/, 'zai'],
  [/^(qwen|qwq)/, 'dashscope'],
  [/^(kimi-|moonshot-)/, 'moonshot'],
  [/^deepseek-/, 'deepseek'],
  [/^minimax-/, 'minimax'],
  [/^grok-/, 'xai'],
  [/^(mistral|devstral|codestral|magistral|ministral|pixtral)/, 'mistral'],
  [/^(gemini-|gemma-)/, 'gemini'],
] as const)

/**
 * Rates from the bundled LiteLLM snapshot. `model` is `provider/id` or a bare id; a trailing `[1m]` and an `@variant` are
 * dropped. Tried in order: the key as given, `${provider}/${id}` when a provider is known, the bare id (after the first
 * `/`), the bare name (after the last `/`) when it differs from the id, the name under its maker's provider when MAKERS
 * knows the name, then the id under each provider of PROVIDER_ORDER. No other matching.
 */
export function litellmRates(model: string, provider?: string, table: LitellmTable = LITELLM): Rates | null {
  const key = model.toLowerCase().replace(/\[1m\]$/, '').replace(/@.*$/, '')
  const id = key.slice(key.indexOf('/') + 1)
  if (id === '') return null
  const name = key.slice(key.lastIndexOf('/') + 1)
  const maker = MAKERS.find(([re]) => re.test(name))?.[1]
  const tries = [
    key,
    ...(provider ? [`${provider.toLowerCase()}/${id}`] : []),
    id,
    ...(name !== id ? [name] : []),
    ...(maker ? [`${maker}/${name}`] : []),
    ...PROVIDER_ORDER.map(p => `${p}/${id}`),
  ]
  for (const k of tries) {
    const row = Object.hasOwn(table, k) ? table[k] : undefined
    if (row) return { input: row[0], output: row[1], cacheRead: row[2], cacheWrite: row[3] }
  }
  return null
}

/** Where a price came from: overrides or the Claude table, the refreshed LiteLLM list, or the list bundled with this version. */
export type PricedBy = 'table' | 'fetched' | 'bundled'

/**
 * Effective rates and where they came from: price overrides, then the Claude table (both are `table`), then the refreshed
 * LiteLLM list (`fetched`, when there is one), then the bundled snapshot.
 */
export function pricedBy(
  model: string,
  totalInput: number,
  table: PriceTable,
  litellm: LitellmTable = LITELLM,
  fetched?: LitellmTable,
): { rates: Rates; from: PricedBy } | null {
  const own = ratesFor(model, totalInput, table)
  if (own) return { rates: own, from: 'table' }
  const fresh = fetched ? litellmRates(model, undefined, fetched) : null
  if (fresh) return { rates: fresh, from: 'fetched' }
  const bundled = litellmRates(model, undefined, litellm)
  return bundled ? { rates: bundled, from: 'bundled' } : null
}

export function ratesForAny(model: string, totalInput: number, table: PriceTable, litellm: LitellmTable = LITELLM, fetched?: LitellmTable): Rates | null {
  return pricedBy(model, totalInput, table, litellm, fetched)?.rates ?? null
}

/** The estimate and the price list it came from, or null when no rate is known. */
export function estimateDetail(
  usage: Usage,
  model: string,
  table: PriceTable,
  litellm: LitellmTable = LITELLM,
  fetched?: LitellmTable,
): { cost: number; from: PricedBy } | null {
  const totalInput = usage.uncached + usage.cacheRead + usage.cacheWrite
  const priced = pricedBy(model, totalInput, table, litellm, fetched)
  if (!priced) return null
  const { rates, from } = priced
  const cost =
    (usage.uncached * rates.input + usage.output * rates.output + usage.cacheRead * rates.cacheRead + usage.cacheWrite * rates.cacheWrite) / 1e6
  return { cost, from }
}

export function estimateCost(usage: Usage, model: string, table: PriceTable, litellm: LitellmTable = LITELLM, fetched?: LitellmTable): number | null {
  return estimateDetail(usage, model, table, litellm, fetched)?.cost ?? null
}

// ---- the refreshed LiteLLM list (spec §3.9)

/** The one URL the plugin fetches: LiteLLM's public price list. */
export const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json' as const
/** The store record the refreshed list is kept in. */
export const PRICES_KEY = 'prices/litellm/v1'

const MAX_LIST_BYTES = 8 * 1024 * 1024
const MAX_LIST_ENTRIES = 6000
const MIN_LIST_ENTRIES = 100
const MAX_PER_MILLION = 10_000
const LIST_KEY = /^[a-z0-9._:/@+-]{1,160}$/

/** USD per million tokens from a per-token price: undefined when absent, null when present but not a sane price. */
function perMillion(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null
  const m = Math.round(v * 1e6 * 1e6) / 1e6
  return m <= MAX_PER_MILLION ? m : null
}

/**
 * LiteLLM's price list reduced to numbers: chat models with a numeric input price, base tier, USD per million tokens
 * `[input, output, cacheRead, cacheWrite]` (a missing cache rate is 0), keys lower-cased. The same rules as
 * scripts/update-prices.mjs. Null for text over 8 MiB, text that is not JSON, or fewer than 100 surviving entries.
 */
export function projectLitellm(text: string): Record<string, Rates4> | null {
  if (typeof text !== 'string' || exceedsBytes(text, MAX_LIST_BYTES)) return null
  let list: unknown
  try {
    list = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof list !== 'object' || list === null || Array.isArray(list)) return null
  const out: Record<string, Rates4> = {}
  let count = 0
  for (const [rawKey, entry] of Object.entries(list)) {
    if (count >= MAX_LIST_ENTRIES) break
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    if (e['mode'] !== 'chat') continue
    const key = rawKey.toLowerCase()
    if (!LIST_KEY.test(key) || key === '__proto__' || key === 'sample_spec' || Object.hasOwn(out, key)) continue
    const input = perMillion(e['input_cost_per_token'])
    const output = perMillion(e['output_cost_per_token'])
    const cacheRead = perMillion(e['cache_read_input_token_cost'])
    const cacheWrite = perMillion(e['cache_creation_input_token_cost'])
    if (input === undefined || input === null || output === null || cacheRead === null || cacheWrite === null) continue
    out[key] = [input, output ?? 0, cacheRead ?? 0, cacheWrite ?? 0]
    count += 1
  }
  return count < MIN_LIST_ENTRIES ? null : out
}

/** What `PRICES_KEY` holds. `fetchedAt` is 0 until a list was fetched; `rates` is then empty. */
export type PriceRecord = { v: 1; fetchedAt: number; attemptedAt: number; rates: Record<string, Rates4> }

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** The record as stored, checked field by field (shape, caps, every number); anything else reads as no record. */
export function parsePriceRecord(value: unknown): PriceRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const r = value as Record<string, unknown>
  if (r['v'] !== 1 || !isTime(r['fetchedAt']) || !isTime(r['attemptedAt'])) return null
  const raw = r['rates']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const keys = Object.keys(raw)
  if (keys.length > MAX_LIST_ENTRIES) return null
  const rates: Record<string, Rates4> = {}
  for (const key of keys) {
    if (!LIST_KEY.test(key) || key === '__proto__') return null
    const row = (raw as Record<string, unknown>)[key]
    if (!Array.isArray(row) || row.length !== 4) return null
    const [a, b, c, d] = row as unknown[]
    for (const n of [a, b, c, d]) if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_PER_MILLION) return null
    rates[key] = [a as number, b as number, c as number, d as number]
  }
  return { v: 1, fetchedAt: r['fetchedAt'], attemptedAt: r['attemptedAt'], rates }
}

/** The refreshed list and the time it was fetched. */
export type FetchedPrices = { rates: LitellmTable; fetchedAt: number }

/**
 * A reader of the stored record that checks the rates once per `fetchedAt` and answers from memory after: each file that
 * prices tokens holds its own (the engine takes no value across files). Undefined when there is no usable list.
 */
export function fetchedPrices(): (value: unknown) => FetchedPrices | undefined {
  let held: FetchedPrices | undefined
  return value => {
    const at = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['fetchedAt'] : undefined
    if (held !== undefined && at === held.fetchedAt) return held
    const record = parsePriceRecord(value)
    held = record !== null && record.fetchedAt > 0 && Object.keys(record.rates).length > 0 ? { rates: record.rates, fetchedAt: record.fetchedAt } : undefined
    return held
  }
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
