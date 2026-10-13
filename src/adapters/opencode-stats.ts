import type { Usage } from '../../types'
import { ident } from '../relay-result'

// Pure projection of `opencode stats --json` stdout (spec §3.3) and the allocation of the
// growth between two snapshots to the runs active in it (spec §3.5). Values are read by name only: the parsed object is never
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

/** The bounds of the adapter's memory in a session: runs, then working directories. */
export const STATS_MAX_RUNS = 256
export const STATS_MAX_FOLDERS = 64
/** A baseline taken this long after a run started still counts as taken at its start (the watch tick plus the process). */
export const STATS_RACE_MS = 1500

const MAX_COUNT = 1e12
const MAX_COST = 1e6

/** True when `text` is more than `max` bytes as UTF-8. The lib settings have no TextEncoder, so the bytes are counted per code unit. */
export function exceedsBytes(text: string, max: number): boolean {
  if (text.length > max) return true
  if (text.length * 3 <= max) return false
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4
      i += 1
    } else bytes += 3
    if (bytes > max) return true
  }
  return false
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function bounded(v: unknown, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined
}

/** A token counter: a whole number within the bound (cost, by contrast, may be fractional). */
function counted(v: unknown, max: number): number | undefined {
  const n = bounded(v, max)
  return n !== undefined && Number.isInteger(n) ? n : undefined
}

function tokensOf(v: unknown, cost: unknown): (StatsTokens & { cost: number }) | null {
  if (!isObject(v)) return null
  const cache = v['cache']
  if (!isObject(cache)) return null
  const input = counted(v['input'], MAX_COUNT)
  const output = counted(v['output'], MAX_COUNT)
  const reasoning = counted(v['reasoning'], MAX_COUNT)
  const cacheRead = counted(cache['read'], MAX_COUNT)
  const cacheWrite = counted(cache['write'], MAX_COUNT)
  const spent = bounded(cost, MAX_COST)
  if (input === undefined || output === undefined || reasoning === undefined) return null
  if (cacheRead === undefined || cacheWrite === undefined || spent === undefined) return null
  return { input, output, reasoning, cacheRead, cacheWrite, cost: spent }
}

/** Null for oversize, non-JSON, or a missing/invalid `tokens` block. Reads by name only; numbers finite, ≥ 0, ≤ 1e12 (cost ≤ 1e6), token counters whole; ids via the v0.1 ident rule. */
export function projectStats(stdout: string, at: number): StatsSnapshot | null {
  if (typeof stdout !== 'string' || exceedsBytes(stdout, MAX_STATS_STDOUT)) return null
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
export function rowKey(snapshot: StatsSnapshot, model: string | undefined): string | null {
  if (model === undefined || model === '') return null
  if (Object.hasOwn(snapshot.models, model)) return model
  const hits = Object.keys(snapshot.models).filter((key) => key.slice(key.lastIndexOf('/') + 1) === model)
  return hits.length === 1 ? hits[0]! : null
}


/** An opencode run as the allocation sees it: who, which model, and when it ran (wall-clock ms). */
export type FolderRun = { id: string; model: string | undefined; startedAt: number; endedAt: number | undefined }
/** What one run was given from the growth between two snapshots of its folder. */
export type Allocation = { id: string; usage: Usage; cost: number; shared: number; approx: boolean }

const COUNTERS = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'cost'] as const
type Counter = (typeof COUNTERS)[number]
type Delta = { values: Record<Counter, number>; regressed: boolean }

/** Growth per counter; a counter that went down counts as 0 and marks the delta `regressed`. */
function deltaOf(to: StatsTokens & { cost: number }, from: StatsTokens & { cost: number }): Delta {
  const values = {} as Record<Counter, number>
  let regressed = false
  for (const counter of COUNTERS) {
    if (to[counter] < from[counter]) regressed = true
    values[counter] = to[counter] < from[counter] ? 0 : to[counter] - from[counter]
  }
  return { values, regressed }
}

/** `whole` split into `parts` integers that sum to it; the remainder goes one each to the first parts. */
function splitWhole(whole: number, parts: number): number[] {
  const total = Math.floor(whole)
  const base = Math.floor(total / parts)
  const rest = total - base * parts
  return Array.from({ length: parts }, (_, i) => base + (i < rest ? 1 : 0))
}

/**
 * What each run active between two snapshots of one folder was given (spec §3.5, amended): every model row's growth is split
 * evenly among the active runs of that model, and the growth no such row accounts for among the active runs whose model is
 * unknown or has no row. Interval (prev.at, cur.at]; a run not active in it gets nothing. Tokens are whole numbers that sum
 * exactly to the growth; cost is divided evenly.
 */
export function allocate(prev: StatsSnapshot, cur: StatsSnapshot, runs: readonly FolderRun[]): Allocation[] {
  const active = runs
    .filter(r => r.startedAt <= cur.at && (r.endedAt === undefined || r.endedAt >= prev.at))
    .sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (active.length === 0) return []

  const members = new Map<string, FolderRun[]>()
  const loose: FolderRun[] = []
  for (const run of active) {
    const key = rowKey(cur, run.model)
    if (key === null) loose.push(run)
    else members.set(key, [...(members.get(key) ?? []), run])
  }

  const outside = cur.sessions - prev.sessions > active.length
  const out: Allocation[] = []
  const give = (delta: Delta, group: readonly FolderRun[]): void => {
    const shares = {} as Record<Counter, number[]>
    for (const counter of COUNTERS) shares[counter] = counter === 'cost' ? [] : splitWhole(delta.values[counter], group.length)
    group.forEach((run, i) => {
      out.push({
        id: run.id,
        usage: {
          uncached: shares.input[i]!,
          output: shares.output[i]! + shares.reasoning[i]!,
          cacheRead: shares.cacheRead[i]!,
          cacheWrite: shares.cacheWrite[i]!,
        },
        cost: delta.values.cost / group.length,
        shared: group.length,
        approx: group.length > 1 || delta.regressed || outside,
      })
    })
  }

  const projectDelta = deltaOf(cur.total, prev.total)
  const taken = {} as Record<Counter, number>
  for (const counter of COUNTERS) taken[counter] = 0
  let rowRegressed = false
  for (const [key, group] of members) {
    const delta = deltaOf(cur.models[key]!, Object.hasOwn(prev.models, key) ? prev.models[key]! : ZERO)
    // a row missing from the earlier snapshot replays its whole history: it cannot have grown more than the project did
    for (const counter of COUNTERS) {
      if (delta.values[counter] > projectDelta.values[counter]) {
        delta.values[counter] = projectDelta.values[counter]
        delta.regressed = true
      }
    }
    for (const counter of COUNTERS) taken[counter] += delta.values[counter]
    rowRegressed = rowRegressed || delta.regressed
    give(delta, group)
  }

  if (loose.length > 0) {
    const total = projectDelta
    const values = {} as Record<Counter, number>
    let clamped = false
    for (const counter of COUNTERS) {
      clamped = clamped || taken[counter] > total.values[counter]
      values[counter] = Math.max(0, total.values[counter] - taken[counter])
    }
    give({ values, regressed: total.regressed || rowRegressed || clamped }, loose)
  }
  return out
}
