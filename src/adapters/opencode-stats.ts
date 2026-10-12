import type { Usage } from '../../types'
import { fingerprint } from '../collect/relay'
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

/** `usage` and `cost` less `other`, each field clamped at 0; `clamped` says whether any field would have gone below. */
function takeAway(usage: Usage, cost: number, other: Usage, otherCost: number): { usage: Usage; cost: number; clamped: boolean } {
  let clamped = false
  const less = (a: number, b: number): number => {
    if (b > a) {
      clamped = true
      return 0
    }
    return a - b
  }
  return {
    usage: {
      uncached: less(usage.uncached, other.uncached),
      output: less(usage.output, other.output),
      cacheRead: less(usage.cacheRead, other.cacheRead),
      cacheWrite: less(usage.cacheWrite, other.cacheWrite),
    },
    cost: less(cost, otherCost),
    clamped,
  }
}

/**
 * What the project total grew by, less what the named model rows grew by over the same window (each field clamped at 0):
 * the share of a run whose model names no row, once other runs have been given their rows. Always approximate.
 */
export function attributeResidual(base: StatsSnapshot, latest: StatsSnapshot, rowKeys: readonly string[]): { usage: Usage; cost: number; approx: true } {
  const total = attribute(base, latest, undefined)
  let usage = total.usage
  let cost = total.cost
  for (const key of rowKeys) {
    if (!Object.hasOwn(latest.models, key)) continue
    const row = attribute(base, latest, key)
    const left = takeAway(usage, cost, row.usage, row.cost)
    usage = left.usage
    cost = left.cost
  }
  return { usage, cost, approx: true }
}

/** The figures a run was last given, and what they were measured against (a group, the exact runs and rows taken away). */
export type StatsLast = { usage: Usage; cost: number; basis: string }

/** A counter that fell since the run's last figures keeps its last value (and the figure is approximate); a changed basis starts over. */
export function holdUp(last: StatsLast | undefined, usage: Usage, cost: number, basis: string): { usage: Usage; cost: number; held: boolean } {
  if (!last || last.basis !== basis) return { usage, cost, held: false }
  let held = false
  const keep = (now: number, before: number): number => {
    if (now < before) {
      held = true
      return before
    }
    return now
  }
  const kept: Usage = {
    uncached: keep(usage.uncached, last.usage.uncached),
    output: keep(usage.output, last.usage.output),
    cacheRead: keep(usage.cacheRead, last.usage.cacheRead),
    cacheWrite: keep(usage.cacheWrite, last.usage.cacheWrite),
  }
  return { usage: kept, cost: keep(cost, last.cost), held }
}

/** Drops the oldest keys (insertion order) of a Map or Set until it holds at most `cap`. */
export function capped<K>(collection: { readonly size: number; keys(): IterableIterator<K>; delete(key: K): boolean }, cap: number): void {
  while (collection.size > cap) {
    const first = collection.keys().next()
    if (first.done) return
    collection.delete(first.value)
  }
}

/** Items whose [start, end] ranges overlap, chained (A meets B, B meets C: one set), in start order. */
export function chainByOverlap<T>(items: readonly T[], range: (item: T) => readonly [number, number]): T[][] {
  const sorted = [...items].sort((a, b) => range(a)[0] - range(b)[0])
  const sets: T[][] = []
  let current: T[] = []
  let reach = 0
  for (const item of sorted) {
    const [start, end] = range(item)
    if (current.length > 0 && start <= reach) {
      current.push(item)
      reach = Math.max(reach, end)
    } else {
      if (current.length > 0) sets.push(current)
      current = [item]
      reach = end
    }
  }
  if (current.length > 0) sets.push(current)
  return sets
}

/** A snapshot of a folder: the data, when its process began (`from`) and when the engine clock said it was taken. */
export type StatsTaken = { snap: StatsSnapshot; from: number; clockAt: number }

/**
 * Whether a folder's snapshot can be a run's baseline: one taken at or before the run started and no older than a
 * poll serves exactly; one taken after serves as the run's first look, approximate unless its process began within
 * the race window after the start. Null when the snapshot is too old to serve.
 */
export function baselineFrom(startedAt: number, taken: { from: number; snap: { at: number } }): { approx: boolean } | null {
  if (taken.snap.at <= startedAt) return startedAt - taken.snap.at <= STATS_EVERY_MS ? { approx: false } : null
  return { approx: taken.from < startedAt || taken.from - startedAt > STATS_RACE_MS }
}

/** An opencode run being measured: its baseline and whether it still needs snapshots (`live`). */
export type StatsRun = {
  id: string
  model: string | undefined
  startedAt: number
  endedAt: number | undefined
  base: StatsSnapshot
  baseApprox: boolean
  live: boolean
  last?: StatsLast
}
/** A run whose relay result gave its exact usage: not measured, but taken away from the group it overlaps. */
export type StatsExact = { id: string; model: string | undefined; startedAt: number; endedAt: number | undefined; usage: Usage; cost: number | null }
export type StatsShare = { id: string; usage: Usage; cost: number; approx: boolean; basis: string; sharedKey?: string; sharedSize?: number }

type Span = readonly [number, number]
const overlaps = (a: Span, b: Span): boolean => a[0] <= b[1] && b[0] <= a[1]

/**
 * The figures every measured run of one folder gets from one snapshot (groups that have a live member only).
 * Runs group by the stats row their model resolves to (provider included); runs whose model resolves to no row group
 * together and are given the project total less the rows the other runs are given. A group's sharedKey names its folder,
 * row and earliest start, so a later group of the same folder and row has its own.
 */
export function planShares(folder: string, runs: readonly StatsRun[], exacts: readonly StatsExact[], snap: StatsSnapshot, now: number): StatsShare[] {
  const keyOf = (model: string | undefined): string => rowKey(snap, model) ?? ''
  const span = (r: { startedAt: number; endedAt: number | undefined }): Span => [r.startedAt, r.endedAt ?? now]

  const byKey = new Map<string, StatsRun[]>()
  for (const run of runs) {
    const key = keyOf(run.model)
    byKey.set(key, [...(byKey.get(key) ?? []), run])
  }
  const groups: Array<{ key: string; members: StatsRun[]; range: Span }> = []
  for (const [key, members] of byKey) {
    for (const chain of chainByOverlap(members, span)) {
      groups.push({ key, members: chain, range: [Math.min(...chain.map(m => m.startedAt)), Math.max(...chain.map(m => m.endedAt ?? now))] })
    }
  }

  const shares: StatsShare[] = []
  for (const group of groups) {
    if (!group.members.some(m => m.live)) continue
    const earliest = group.members.reduce((a, b) => (b.base.at < a.base.at ? b : a))
    const base = earliest.base
    const mine = exacts.filter(e => keyOf(e.model) === group.key && overlaps(span(e), group.range))

    let usage: Usage
    let cost: number
    let approx: boolean
    let subtracted: string[] = []
    if (group.key !== '') {
      const row = attribute(base, snap, group.key)
      usage = row.usage
      cost = row.cost
      approx = row.approx
    } else {
      const rows = new Set<string>()
      for (const other of groups) if (other !== group && other.key !== '' && overlaps(other.range, group.range)) rows.add(other.key)
      for (const e of exacts) {
        const key = keyOf(e.model)
        if (key !== '' && overlaps(span(e), group.range)) rows.add(key)
      }
      subtracted = [...rows].sort()
      const rest = attributeResidual(base, snap, subtracted)
      usage = rest.usage
      cost = rest.cost
      approx = true
    }
    // an exact member of this group is taken out of what the group shows
    for (const e of mine) {
      const left = takeAway(usage, cost, e.usage, e.cost ?? 0)
      usage = left.usage
      cost = left.cost
      approx = true
    }
    const window: Span = [base.at, snap.at]
    const tracked = [...runs, ...exacts].filter(r => overlaps(span(r), window)).length
    approx = approx || earliest.baseApprox || snap.sessions - base.sessions > tracked

    const sharedKey = group.members.length > 1 ? fingerprint(`${folder}|${group.key}|${Math.min(...group.members.map(m => m.startedAt))}`) : undefined
    const basis = `${sharedKey ?? ''}|${mine.map(e => e.id).sort().join(',')}|${subtracted.join(',')}`
    for (const member of group.members) {
      const held = holdUp(member.last, usage, cost, basis)
      shares.push({
        id: member.id,
        usage: held.usage,
        cost: held.cost,
        approx: approx || held.held,
        basis,
        ...(sharedKey !== undefined ? { sharedKey, sharedSize: group.members.length } : {}),
      })
    }
  }
  return shares
}
