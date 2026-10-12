import type { Usage } from '../../types'
import { ident } from '../relay-result'

// Pure projection of `opencode stats --json` stdout (spec §3.3) and the attribution of a
// run's share of it (spec §3.5). Values are read by name only: the parsed object is never
// iterated, stringified or kept, so no field outside the allow-list can leave this module.

export type StatsTokens = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
export type StatsSnapshot = {
  at: number
  sessions: number
  total: StatsTokens & { cost: number }
  models: Record<string, StatsTokens & { cost: number }> // key `${providerID}/${id}`
}

export const STATS_ARGV: readonly string[] = Object.freeze(['opencode', 'stats', '--json', '--days', '1', '--models', '--cost', '--project', '.'])
export const STATS_TIMEOUT_MS = 10_000
export const STATS_EVERY_MS = 10_000
export const MAX_STATS_STDOUT = 1_048_576
export const MAX_STATS_MODELS = 64

const MAX_COUNT = 1e12
const MAX_COST = 1e6

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function bounded(v: unknown, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined
}

function tokensOf(v: unknown, cost: unknown): (StatsTokens & { cost: number }) | null {
  if (!isObject(v)) return null
  const cache = v['cache']
  if (!isObject(cache)) return null
  const input = bounded(v['input'], MAX_COUNT)
  const output = bounded(v['output'], MAX_COUNT)
  const reasoning = bounded(v['reasoning'], MAX_COUNT)
  const cacheRead = bounded(cache['read'], MAX_COUNT)
  const cacheWrite = bounded(cache['write'], MAX_COUNT)
  const spent = bounded(cost, MAX_COST)
  if (input === undefined || output === undefined || reasoning === undefined) return null
  if (cacheRead === undefined || cacheWrite === undefined || spent === undefined) return null
  return { input, output, reasoning, cacheRead, cacheWrite, cost: spent }
}

/** Null for oversize, non-JSON, or a missing/invalid `tokens` block. Reads by name only; numbers finite, ≥ 0, ≤ 1e12 (cost ≤ 1e6); ids via the v0.1 ident rule. */
export function projectStats(stdout: string, at: number): StatsSnapshot | null {
  if (typeof stdout !== 'string' || stdout.length > MAX_STATS_STDOUT) return null
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!isObject(raw)) return null
  const sessions = bounded(raw['sessions'], MAX_COUNT)
  const total = tokensOf(raw['tokens'], raw['cost'])
  if (sessions === undefined || total === null) return null

  const models: StatsSnapshot['models'] = {}
  const rows = raw['models']
  if (Array.isArray(rows)) {
    for (const row of rows.slice(0, MAX_STATS_MODELS) as unknown[]) {
      if (!isObject(row)) continue
      const model = row['model']
      if (!isObject(model)) continue
      const id = ident(model['id'])
      const provider = ident(model['providerID'])
      if (id === undefined || provider === undefined) continue
      const numbers = tokensOf(row['tokens'], row['cost'])
      if (numbers === null) continue
      const key = `${provider}/${id}`
      // one model run at two variants is two rows with one key: they add up
      const seen = Object.hasOwn(models, key) ? models[key] : undefined
      models[key] = seen
        ? {
            input: seen.input + numbers.input,
            output: seen.output + numbers.output,
            reasoning: seen.reasoning + numbers.reasoning,
            cacheRead: seen.cacheRead + numbers.cacheRead,
            cacheWrite: seen.cacheWrite + numbers.cacheWrite,
            cost: seen.cost + numbers.cost,
          }
        : numbers
    }
  }
  return { at, sessions, total, models }
}

const ZERO: StatsTokens & { cost: number } = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }

/** The key a run's model names: exact, or by the part after the last '/'. Null when absent or ambiguous. */
function rowKey(snapshot: StatsSnapshot, model: string | undefined): string | null {
  if (model === undefined || model === '') return null
  if (Object.hasOwn(snapshot.models, model)) return model
  const hits = Object.keys(snapshot.models).filter((key) => key.slice(key.lastIndexOf('/') + 1) === model)
  return hits.length === 1 ? hits[0]! : null
}

/** `model` matches a key exactly or by its part after the last '/' (a run's `-m openai/gpt-6.1-sol` or `gpt-6.1-sol`). */
export function attribute(base: StatsSnapshot, latest: StatsSnapshot, model: string | undefined): { usage: Usage; cost: number; approx: boolean; byModel: boolean } {
  const key = rowKey(latest, model)
  const to = key === null ? latest.total : latest.models[key]!
  const from = key === null ? base.total : (Object.hasOwn(base.models, key) ? base.models[key]! : ZERO)

  let approx = false
  const delta = (now: number, before: number): number => {
    if (now < before) {
      approx = true
      return 0
    }
    return now - before
  }

  const usage: Usage = {
    uncached: delta(to.input, from.input),
    output: delta(to.output, from.output) + delta(to.reasoning, from.reasoning),
    cacheRead: delta(to.cacheRead, from.cacheRead),
    cacheWrite: delta(to.cacheWrite, from.cacheWrite),
  }
  const cost = delta(to.cost, from.cost)
  return { usage, cost, approx, byModel: key !== null }
}
