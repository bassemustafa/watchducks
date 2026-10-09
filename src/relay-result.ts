import type { RelayProjection, RunStatus, Usage } from '../types'

// Pure allow-list projection of a relay result.json (spec §6.3). Keys are read
// by name only: the object is never iterated and `finalMessage` is never touched.

export const RELAY_SCHEMA = 'delegate-relay.result.v1' as const
export const MAX_RESULT_BYTES = 1048576 as const

const MAX_IDENT = 80
const IDENT = /^[A-Za-z0-9._:/#@+~-]+$/
const MAX_COUNT = 1e12
const MAX_COST = 1e6

const STATUS: Readonly<Record<string, RunStatus>> = {
  completed: 'done',
  failed: 'failed',
  timeout: 'failed',
  aborted: 'killed',
}

function statusOf(v: unknown): RunStatus {
  return typeof v === 'string' && Object.hasOwn(STATUS, v) ? STATUS[v]! : 'ended'
}

function ident(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_IDENT && IDENT.test(v) ? v : undefined
}

function bounded(v: unknown, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined
}

function stamp(v: unknown): number | undefined {
  if (typeof v !== 'string' || v.length > MAX_IDENT) return undefined
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? undefined : ms
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function projectUsage(v: unknown): Usage | null {
  if (!isObject(v)) return null
  const uncached = bounded(v['input_tokens'], MAX_COUNT)
  const output = bounded(v['output_tokens'], MAX_COUNT)
  const cacheRead = bounded(v['cache_read_input_tokens'], MAX_COUNT)
  const cacheWrite = bounded(v['cache_creation_input_tokens'], MAX_COUNT)
  if (uncached === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return null
  return { uncached, output, cacheRead, cacheWrite }
}

/** Null when the text is too large, not JSON, not an object, or not the v1 schema. */
export function projectRelayResult(text: string): RelayProjection | null {
  if (typeof text !== 'string' || text.length > MAX_RESULT_BYTES) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(raw) || raw['schema'] !== RELAY_SCHEMA) return null

  const tool = raw['tool']
  const projection: RelayProjection = {
    status: statusOf(raw['status']),
    readOnly: raw['agent'] === 'plan' || raw['readOnly'] === true || raw['sandbox'] === 'read-only',
    costReported: bounded(raw['totalCostUsd'] ?? raw['cost'], MAX_COST) ?? null,
    usage: projectUsage(raw['usage']),
    touchedFiles: Array.isArray(raw['touchedFiles']) ? raw['touchedFiles'].length : null,
  }
  const exitCode = bounded(raw['exitCode'], MAX_COUNT)
  if (exitCode !== undefined) projection.exitCode = exitCode
  const lane = ident(raw['lane'])
  if (lane !== undefined) projection.lane = lane
  if (tool === 'opencode' || tool === 'claude' || tool === 'codex') projection.implementer = tool
  const model = ident(raw['model'])
  if (model !== undefined) projection.model = model
  const effort = ident(raw['effort']) ?? ident(raw['variant'])
  if (effort !== undefined) projection.effort = effort
  const startedAt = stamp(raw['startedAt'])
  if (startedAt !== undefined) projection.startedAt = startedAt
  const finishedAt = stamp(raw['finishedAt'])
  if (finishedAt !== undefined) projection.finishedAt = finishedAt
  return projection
}

/** Separator-aware containment of an already-resolved real path in any allowed root. */
export function isInsideRoots(realPath: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    // An empty entry (e.g. from splitting an unset path list) allows nothing.
    if (root === '') continue
    const r = root.endsWith('/') ? root.slice(0, -1) : root
    if (realPath === r || realPath.startsWith(r + '/')) return true
  }
  return false
}
