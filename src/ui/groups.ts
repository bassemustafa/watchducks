import type { Implementer, Ledger, Run, RunStatus, Usage } from '../../types'
import { shownCost, type CostSource, type Pricing } from '../cost'

// Pure grouping of the field (spec §9.2): runs of the same implementer, model and effort share one card and one
// dossier. Numbers, identifiers and enums only; no `$`, no element tree.

export const GROUP_PREFIX = 'group:'

/** Running runs newest first, then ended ones newest first. */
export function orderedRuns(ledger: Ledger): Run[] {
  const runs: Run[] = []
  for (const id of ledger.order) {
    const run = Object.hasOwn(ledger.runs, id) ? ledger.runs[id] : undefined
    if (run) runs.push(run)
  }
  const running = runs.filter(r => r.status === 'running').sort((a, b) => b.startedAt - a.startedAt)
  const ended = runs.filter(r => r.status !== 'running').sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
  return [...running, ...ended]
}

export type Group = {
  /** The dossier id: `group:` and the key. */
  id: string
  implementer: Implementer
  /** `'—'` when no run says. */
  model: string
  /** `'—'` when no run says. */
  effort: string
  /** In `orderedRuns` order. */
  runs: Run[]
}

function keyParts(run: Run): { model: string; effort: string } {
  return { model: run.model ?? '—', effort: run.effort === undefined ? '—' : String(run.effort) }
}

/** The dossier id of the group a run belongs to. */
export function groupIdOf(run: Run): string {
  const { model, effort } = keyParts(run)
  return `${GROUP_PREFIX}${run.implementer}|${model}|${effort}`
}

const newestEnd = (g: Group): number => Math.max(...g.runs.map(r => r.endedAt ?? r.startedAt))
const newestStart = (g: Group): number => Math.max(...g.runs.filter(r => r.status === 'running').map(r => r.startedAt))
const isRunning = (g: Group): boolean => g.runs.some(r => r.status === 'running')

/** The field's groups: those with a running run first (by that run's start), then the rest by their newest end; ties by id. */
export function groupsOf(ledger: Ledger): Group[] {
  const byId = new Map<string, Group>()
  for (const run of orderedRuns(ledger)) {
    const id = groupIdOf(run)
    const had = byId.get(id)
    if (had) had.runs.push(run)
    else byId.set(id, { id, implementer: run.implementer, ...keyParts(run), runs: [run] })
  }
  return [...byId.values()].sort((a, b) => {
    const ra = isRunning(a)
    const rb = isRunning(b)
    if (ra !== rb) return ra ? -1 : 1
    const by = ra ? newestStart(b) - newestStart(a) : newestEnd(b) - newestEnd(a)
    return by !== 0 ? by : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/** The status whose dot and color a group card wears: running when any run is, else the most recently ended run's. */
export function groupStatus(group: Group): RunStatus {
  return group.runs.some(r => r.status === 'running') ? 'running' : (group.runs[0]?.status ?? 'unknown')
}

export type GroupFigures = {
  counts: Record<RunStatus, number>
  tasks: number
  /** Earliest start to now while any run is running, else to the latest end. */
  elapsedMs: number
  /** Summed totals of the runs that have usage; null when none has. */
  tokens: number | null
  approx: boolean
  /** The summed usage parts, null when no run has usage. */
  usage: Usage | null
  cost: number | null
  costSource: CostSource | null
  costPartial: boolean
  /** Runs with at least one review. */
  vetted: number
  /** Bugs the runs reported plus their reviews' bugs. */
  bugs: number
}

/** The figures of a group: its runs' own figures (not their child rows), summed. */
export function groupFigures(group: Group, now: number, pricing: Pricing): GroupFigures {
  const counts: Record<RunStatus, number> = { running: 0, done: 0, failed: 0, killed: 0, ended: 0, unknown: 0 }
  const sum: Usage = { uncached: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let measured = false
  let approx = false
  let cost: number | null = null
  let allReported = true
  let costPartial = false
  let vetted = 0
  let bugs = 0
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const run of group.runs) {
    counts[run.status] += 1
    start = Math.min(start, run.startedAt)
    end = Math.max(end, run.endedAt ?? run.startedAt)
    if (run.usage) {
      measured = true
      sum.uncached += run.usage.uncached
      sum.output += run.usage.output
      sum.cacheRead += run.usage.cacheRead
      sum.cacheWrite += run.usage.cacheWrite
      if (run.approx) approx = true
    }
    const shown = shownCost(run, pricing.mode, pricing.table, pricing.fetched)
    if (shown.cost !== null) {
      cost = (cost ?? 0) + shown.cost
      if (shown.source !== 'reported') allReported = false
      if (shown.partial) costPartial = true
    } else if (run.kind === 'agent' || (run.kind === 'relay' && run.implementer !== 'codex' && run.outDir !== undefined)) {
      // an agent, or a relay that could report one, with no cost yet (as unknownCostOps in src/history.ts)
      costPartial = true
    }
    if (run.reviews.length > 0) vetted += 1
    bugs += run.bugsReported
    for (const review of run.reviews) bugs += review.bugs ?? 0
  }
  const running = counts.running > 0
  return {
    counts,
    tasks: group.runs.length,
    elapsedMs: group.runs.length === 0 ? Number.NaN : (running ? now : end) - start,
    tokens: measured ? sum.uncached + sum.output + sum.cacheRead + sum.cacheWrite : null,
    approx,
    usage: measured ? sum : null,
    cost,
    costSource: cost === null ? null : allReported ? 'reported' : 'estimated',
    costPartial,
    vetted,
    bugs,
  }
}

const COUNT_WORDS: ReadonlyArray<readonly [RunStatus, string]> = [
  ['running', 'in field'],
  ['done', 'debriefed'],
  ['failed', 'dark'],
  ['killed', 'burned'],
  ['ended', 'returned'],
  ['unknown', 'off radar'],
]

/** The non-zero status counts in card order, e.g. `2 in field`; the status picks the color. */
export function countParts(f: GroupFigures): Array<{ status: RunStatus; text: string }> {
  return COUNT_WORDS.filter(([status]) => f.counts[status] > 0).map(([status, word]) => ({ status, text: `${f.counts[status]} ${word}` }))
}

export function taskCount(n: number): string {
  return n === 1 ? '1 task' : `${n} tasks`
}

/** `implementer · model · effort`. */
export function groupLabel(group: Group): string {
  return `${group.implementer} · ${group.model} · ${group.effort}`
}

/** `X of N · Y leaks each`, or `none` when no run is vetted. */
export function vettedText(f: GroupFigures): string {
  return f.vetted === 0 ? 'none' : `${f.vetted} of ${f.tasks} · ${(f.bugs / f.vetted).toFixed(1)} leaks each`
}
