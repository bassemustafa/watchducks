import type { Classification, Implementer, Ledger, RelayProjection, Review, Run, RunStatus, Spend, Usage } from '../types'
import { fnv1a, codenameFor } from './codename'
import { ZERO_USAGE, addUsage, estimateCost, usageFromApi, type PriceTable } from './price'

// Pure ledger reducer (spec §5-§7): every action returns a new ledger and the
// input is never mutated. Only numbers, identifiers and enums pass through.

export type StepUsage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type Action =
  | { type: 'spawn'; id: string; agentType: string; requestedModel?: string; parentId?: string; at: number }
  | { type: 'step'; loop?: string; turnId: string; index: number; model: string; effort?: string | number; usage: StepUsage | null; at: number }
  | { type: 'turnComplete'; loop?: string; turnId: string; reason: 'answer' | 'aborted' | 'refusal' | 'error'; usage?: StepUsage; at: number }
  | { type: 'agentStatus'; id: string; status: string; at: number }
  | { type: 'bashStart'; id: string; cls: Classification; at: number }
  | { type: 'bashResult'; id: string; isError: boolean; interrupted: boolean; backgroundTaskId?: string; at: number }
  | { type: 'bgSnapshot'; taskIds: readonly string[]; at: number }
  | { type: 'relayResult'; id: string; proj: RelayProjection; at: number }
  | { type: 'editCall'; loop?: string; at: number }
  | { type: 'findings'; loop?: string; toolUseId: string; count: number; at: number }
  | { type: 'verdict'; targetId: string; reviewerId?: string; bugs?: number; edits?: number; at: number }
  | { type: 'clear'; at: number }

export type Totals = {
  running: number
  done: number
  failed: number
  killed: number
  ended: number
  unknown: number
  usage: Usage
  cost: number | null
  costPartial: boolean
  byImplementer: Record<string, number>
}

const SERIES_MAX = 30
const MINUTE_MS = 60_000
const MAX_HANDLERS = 3

export function emptyLedger(sessionId: string, at: number): Ledger {
  return {
    v: 1,
    generation: 0,
    sessionId,
    sessionStartedAt: at,
    runs: {},
    order: [],
    hq: emptySpend(),
    overhead: emptySpend(),
    turnsWithSteps: {},
    countedSteps: {},
    findings: {},
    bgSeen: {},
    tokenSeries: [],
    seriesEndMinute: 0,
  }
}

function emptySpend(): Spend {
  return { usage: { ...ZERO_USAGE }, cost: null, costPartial: false }
}

export function workdirKey(path: string): string {
  return fnv1a(path).toString(36)
}

function getRun(ledger: Ledger, id: string): Run | undefined {
  return Object.hasOwn(ledger.runs, id) ? ledger.runs[id] : undefined
}

export function isKnownLoop(ledger: Ledger, loop: string): boolean {
  return Object.hasOwn(ledger.runs, loop)
}

/** By id first, then by codename (case-insensitive); two codename matches are ambiguous. */
export function resolveRun(ledger: Ledger, ref: string): Run | 'ambiguous' | undefined {
  const byId = getRun(ledger, ref)
  if (byId) return byId
  const wanted = ref.toLowerCase()
  let found: Run | undefined
  for (const id of ledger.order) {
    const run = getRun(ledger, id)
    if (!run || run.codename.toLowerCase() !== wanted) continue
    if (found) return 'ambiguous'
    found = run
  }
  return found
}

function putRun(ledger: Ledger, run: Run): Ledger {
  return { ...ledger, runs: { ...ledger.runs, [run.id]: run } }
}

function patchRun(ledger: Ledger, id: string, patch: Partial<Run>): Ledger {
  const run = getRun(ledger, id)
  return run ? putRun(ledger, { ...run, ...patch }) : ledger
}

function newRun(ledger: Ledger, id: string, kind: Run['kind'], implementer: Implementer, at: number): Run {
  const taken = new Set<string>()
  for (const other of Object.values(ledger.runs)) taken.add(other.codename)
  return {
    id,
    kind,
    codename: codenameFor(id, taken),
    implementer,
    readOnly: false,
    status: 'running',
    startedAt: at,
    usage: null,
    usageSource: null,
    cost: null,
    costSource: null,
    costPartial: false,
    editCalls: 0,
    bugsReported: 0,
    reviews: [],
    suspectedHandlers: [],
  }
}

function addRun(ledger: Ledger, run: Run): Ledger {
  return { ...putRun(ledger, run), order: [...ledger.order, run.id] }
}

function finish(run: Run, status: RunStatus, at: number): Run {
  return { ...run, status, endedAt: at, durationMs: Math.max(0, at - run.startedAt) }
}

/** Back to running: a resumed run has not ended. */
function resume(run: Run): Run {
  const { endedAt: _endedAt, durationMs: _durationMs, ...rest } = run
  return { ...rest, status: 'running' }
}

function isTerminal(status: RunStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'killed'
}

function addSpend(spend: Spend, usage: Usage, cost: number | null): Spend {
  return {
    usage: addUsage(spend.usage, usage),
    cost: cost === null ? spend.cost : (spend.cost ?? 0) + cost,
    costPartial: spend.costPartial || cost === null,
  }
}

/** Add total tokens to the minute bucket; the series always ends at the newest minute seen. */
function bumpSeries(ledger: Ledger, at: number, tokens: number): Ledger {
  const minute = Math.floor(at / MINUTE_MS)
  const series = ledger.tokenSeries
  if (series.length === 0) return { ...ledger, tokenSeries: [tokens], seriesEndMinute: minute }
  const end = ledger.seriesEndMinute
  if (minute > end) {
    const gap = Math.min(minute - end - 1, SERIES_MAX)
    const grown = [...series, ...new Array<number>(gap).fill(0), tokens]
    return { ...ledger, tokenSeries: grown.slice(-SERIES_MAX), seriesEndMinute: minute }
  }
  const slot = series.length - 1 - (end - minute)
  if (slot < 0) return ledger
  const next = series.slice()
  next[slot] = (next[slot] ?? 0) + tokens
  return { ...ledger, tokenSeries: next }
}

/** Charge one request to its loop's owner: HQ, a run, or engine overhead. */
function charge(
  ledger: Ledger,
  loop: string | undefined,
  usage: StepUsage,
  fallbackModel: string,
  source: 'steps' | 'complete',
  at: number,
  prices: PriceTable,
): Ledger {
  const used = usageFromApi(usage)
  const cost = estimateCost(used, usage.model || fallbackModel, prices)
  if (loop === undefined) return { ...ledger, hq: addSpend(ledger.hq, used, cost) }
  const run = getRun(ledger, loop)
  if (!run) return { ...ledger, overhead: addSpend(ledger.overhead, used, cost) }
  const charged: Run = {
    ...run,
    usage: addUsage(run.usage ?? ZERO_USAGE, used),
    usageSource: source === 'steps' ? 'steps' : (run.usageSource ?? 'complete'),
    ...(cost === null ? { costPartial: true } : { cost: (run.cost ?? 0) + cost, costSource: 'estimated' as const }),
  }
  const tokens = used.uncached + used.output + used.cacheRead + used.cacheWrite
  return bumpSeries(putRun(ledger, charged), at, tokens)
}

function stepKey(loop: string | undefined, turnId: string, index: number): string {
  return `${loop ?? 'main'}|${turnId}|${index}`
}

function turnKey(loop: string | undefined, turnId: string): string {
  return `${loop ?? 'main'}|${turnId}`
}

function reduceStep(ledger: Ledger, a: Extract<Action, { type: 'step' }>, prices: PriceTable): Ledger {
  const key = stepKey(a.loop, a.turnId, a.index)
  if (Object.hasOwn(ledger.countedSteps, key)) return ledger
  let next = ledger
  if (a.usage) {
    next = charge(next, a.loop, a.usage, a.model, 'steps', a.at, prices)
    next = {
      ...next,
      countedSteps: { ...next.countedSteps, [key]: true },
      turnsWithSteps: { ...next.turnsWithSteps, [turnKey(a.loop, a.turnId)]: true },
    }
  }
  const run = a.loop === undefined ? undefined : getRun(next, a.loop)
  if (!run) return next
  const model = a.usage?.model || a.model
  const models = run.models ?? []
  const observed: Run = {
    ...run,
    model,
    models: models.includes(model) ? models : [...models, model],
    ...(a.effort !== undefined ? { effort: a.effort, effortSource: 'observed' as const } : {}),
  }
  const resumed = isTerminal(run.status)
  return resumed ? withHandlers(putRun(next, resume(observed))) : putRun(next, observed)
}

function reduceTurnComplete(ledger: Ledger, a: Extract<Action, { type: 'turnComplete' }>, prices: PriceTable): Ledger {
  let next = ledger
  const key = stepKey(a.loop, a.turnId, -1)
  if (a.usage && !Object.hasOwn(next.turnsWithSteps, turnKey(a.loop, a.turnId)) && !Object.hasOwn(next.countedSteps, key)) {
    next = charge(next, a.loop, a.usage, a.usage.model, 'complete', a.at, prices)
    next = { ...next, countedSteps: { ...next.countedSteps, [key]: true } }
  }
  const run = a.loop === undefined ? undefined : getRun(next, a.loop)
  if (!run) return next
  const status: RunStatus = a.reason === 'answer' ? 'done' : a.reason === 'aborted' ? 'killed' : 'failed'
  return withHandlers(putRun(next, finish(run, status, a.at)))
}

function reduceAgentStatus(ledger: Ledger, a: Extract<Action, { type: 'agentStatus' }>): Ledger {
  const run = getRun(ledger, a.id)
  if (!run || run.kind !== 'agent') return ledger
  const word = a.status.toLowerCase()
  if (word === 'running') return run.status === 'running' ? ledger : withHandlers(putRun(ledger, resume(run)))
  const status: RunStatus | undefined =
    word === 'completed' || word === 'done' ? 'done' : word === 'failed' ? 'failed' : word === 'killed' || word === 'stopped' ? 'killed' : undefined
  if (!status || run.status === status) return ledger
  return withHandlers(putRun(ledger, finish(run, status, a.at)))
}

function reduceSpawn(ledger: Ledger, a: Extract<Action, { type: 'spawn' }>): Ledger {
  if (Object.hasOwn(ledger.runs, a.id)) return ledger
  const base = newRun(ledger, a.id, 'agent', 'claude-code', a.at)
  const run: Run = {
    ...base,
    agentType: a.agentType,
    ...(a.requestedModel !== undefined ? { model: a.requestedModel } : {}),
    ...(a.parentId !== undefined ? { parentId: a.parentId } : {}),
  }
  return withHandlers(addRun(ledger, run))
}

function reduceBashStart(ledger: Ledger, a: Extract<Action, { type: 'bashStart' }>): Ledger {
  if (Object.hasOwn(ledger.runs, a.id)) return ledger
  const cls = a.cls
  let run: Run
  if (cls.kind === 'relay') {
    run = {
      ...newRun(ledger, a.id, 'relay', cls.implementer, a.at),
      readOnly: cls.readOnly,
      ...(cls.lane !== undefined ? { lane: cls.lane } : {}),
      ...(cls.model !== undefined ? { model: cls.model } : {}),
      ...(cls.effort !== undefined ? { effort: cls.effort, effortSource: 'flag' as const } : {}),
      ...(cls.workdir !== undefined ? { workdirKey: workdirKey(cls.workdir) } : {}),
      ...(cls.outDir !== undefined ? { outDir: cls.outDir } : {}),
    }
  } else if (cls.kind === 'cli') {
    run = {
      ...newRun(ledger, a.id, 'cli', cls.implementer, a.at),
      ...(cls.model !== undefined ? { model: cls.model } : {}),
      ...(cls.effort !== undefined ? { effort: cls.effort, effortSource: 'flag' as const } : {}),
      ...(cls.workdir !== undefined ? { workdirKey: workdirKey(cls.workdir) } : {}),
    }
  } else {
    run = newRun(ledger, a.id, 'shell', 'shell', a.at)
  }
  return withHandlers(addRun(ledger, run))
}

function reduceBashResult(ledger: Ledger, a: Extract<Action, { type: 'bashResult' }>): Ledger {
  const run = getRun(ledger, a.id)
  if (!run || run.status !== 'running') return ledger
  if (a.backgroundTaskId !== undefined) {
    const kept = putRun(ledger, { ...run, backgroundTaskId: a.backgroundTaskId })
    return { ...kept, bgSeen: { ...kept.bgSeen, [a.backgroundTaskId]: a.id } }
  }
  if (run.kind === 'shell') {
    const { [a.id]: _gone, ...runs } = ledger.runs
    return withHandlers({ ...ledger, runs, order: ledger.order.filter(id => id !== a.id) })
  }
  const status: RunStatus = a.interrupted ? 'killed' : a.isError ? 'failed' : 'done'
  return withHandlers(putRun(ledger, finish(run, status, a.at)))
}

function reduceBgSnapshot(ledger: Ledger, a: Extract<Action, { type: 'bgSnapshot' }>): Ledger {
  const present = new Set(a.taskIds)
  const changed: Run[] = []
  for (const [taskId, runId] of Object.entries(ledger.bgSeen)) {
    const run = getRun(ledger, runId)
    if (!run || run.status !== 'running' || present.has(taskId)) continue
    // gone from the snapshot: returned, outcome unknown; a relay's result.json
    // (read for a grace period after endedAt) can still give the real status
    changed.push(finish(run, 'ended', a.at))
  }
  if (changed.length === 0) return ledger
  return withHandlers({ ...ledger, runs: { ...ledger.runs, ...Object.fromEntries(changed.map(r => [r.id, r])) } })
}

function reduceRelayResult(ledger: Ledger, a: Extract<Action, { type: 'relayResult' }>, prices: PriceTable): Ledger {
  const run = getRun(ledger, a.id)
  if (!run) return ledger
  const p = a.proj
  const model = p.model ?? run.model
  const usage = p.usage ?? run.usage
  let cost: number | null = null
  let costSource: Run['costSource'] = null
  let costPartial = false
  if (p.costReported !== null) {
    cost = p.costReported
    costSource = 'reported'
  } else if (usage && run.implementer === 'claude') {
    const estimate = model !== undefined ? estimateCost(usage, model, prices) : null
    if (estimate === null) costPartial = true
    else {
      cost = estimate
      costSource = 'estimated'
    }
  }
  const updated: Run = {
    ...run,
    status: p.status,
    readOnly: run.readOnly || p.readOnly,
    usage,
    usageSource: p.usage ? 'relay' : run.usageSource,
    cost,
    costSource,
    costPartial,
    ...(p.lane !== undefined ? { lane: p.lane } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(p.effort !== undefined ? { effort: p.effort, effortSource: 'reported' as const } : {}),
    ...(p.touchedFiles !== null ? { editCalls: p.touchedFiles } : {}),
  }
  const settled = p.status === 'running' ? updated : finish(updated, p.status, p.finishedAt ?? a.at)
  return withHandlers(putRun(ledger, settled))
}

function reduceFindings(ledger: Ledger, a: Extract<Action, { type: 'findings' }>): Ledger {
  const runId = a.loop ?? 'main'
  const count = Number.isFinite(a.count) && a.count > 0 ? a.count : 0
  const findings = { ...ledger.findings, [a.toolUseId]: { runId, count } }
  const next = { ...ledger, findings }
  const run = getRun(next, runId)
  if (!run) return next
  let sum = 0
  for (const entry of Object.values(findings)) if (entry.runId === runId) sum += entry.count
  return putRun(next, { ...run, bugsReported: sum })
}

function reduceVerdict(ledger: Ledger, a: Extract<Action, { type: 'verdict' }>): Ledger {
  const target = resolveRun(ledger, a.targetId)
  if (!target || target === 'ambiguous') return ledger
  let reviewerId = 'hq'
  if (a.reviewerId !== undefined) {
    const reviewer = resolveRun(ledger, a.reviewerId)
    if (!reviewer || reviewer === 'ambiguous') return ledger
    reviewerId = reviewer.id
  }
  const review: Review = { reviewerId, bugs: a.bugs ?? null, edits: a.edits ?? null, source: 'verdict', at: a.at }
  const reviews = [...target.reviews.filter(r => r.reviewerId !== reviewerId), review]
  return putRun(ledger, { ...target, reviews })
}

function reduceClear(ledger: Ledger): Ledger {
  const kept: Record<string, Run> = {}
  for (const [id, run] of Object.entries(ledger.runs)) if (run.status === 'running') kept[id] = run
  const findings: Ledger['findings'] = {}
  for (const [toolUseId, entry] of Object.entries(ledger.findings)) {
    if (entry.runId === 'main' || Object.hasOwn(kept, entry.runId)) findings[toolUseId] = entry
  }
  const bgSeen: Ledger['bgSeen'] = {}
  for (const [taskId, runId] of Object.entries(ledger.bgSeen)) if (Object.hasOwn(kept, runId)) bgSeen[taskId] = runId
  // countedSteps / turnsWithSteps are kept so a replayed step is still not counted twice
  return withHandlers({
    ...ledger,
    generation: ledger.generation + 1,
    runs: kept,
    order: ledger.order.filter(id => Object.hasOwn(kept, id)),
    findings,
    bgSeen,
  })
}

function isReviewer(run: Run): boolean {
  return run.lane === 'review' || run.lane === 'debate' || (run.agentType !== undefined && /review/i.test(run.agentType)) || run.readOnly
}

/** Suspected handlers: reviewers on the same workdir that started after the work ended (spec §6.4). */
function withHandlers(ledger: Ledger): Ledger {
  const candidates: { run: Run; at: number }[] = []
  ledger.order.forEach((id, at) => {
    const run = getRun(ledger, id)
    if (run && isReviewer(run)) candidates.push({ run, at })
  })
  const changed: Run[] = []
  for (const id of ledger.order) {
    const run = getRun(ledger, id)
    if (!run) continue
    let handlers: string[] = []
    if (!isReviewer(run) && run.workdirKey !== undefined && run.endedAt !== undefined) {
      const ended = run.endedAt
      handlers = candidates
        .filter(c => c.run.workdirKey === run.workdirKey && c.run.startedAt >= ended)
        .sort((x, y) => y.run.startedAt - x.run.startedAt || y.at - x.at)
        .slice(0, MAX_HANDLERS)
        .map(c => c.run.id)
    }
    const same = handlers.length === run.suspectedHandlers.length && handlers.every((h, i) => h === run.suspectedHandlers[i])
    if (!same) changed.push({ ...run, suspectedHandlers: handlers })
  }
  if (changed.length === 0) return ledger
  return { ...ledger, runs: { ...ledger.runs, ...Object.fromEntries(changed.map(r => [r.id, r])) } }
}

export function reduce(ledger: Ledger, action: Action, prices: PriceTable): Ledger {
  switch (action.type) {
    case 'spawn':
      return reduceSpawn(ledger, action)
    case 'step':
      return reduceStep(ledger, action, prices)
    case 'turnComplete':
      return reduceTurnComplete(ledger, action, prices)
    case 'agentStatus':
      return reduceAgentStatus(ledger, action)
    case 'bashStart':
      return reduceBashStart(ledger, action)
    case 'bashResult':
      return reduceBashResult(ledger, action)
    case 'bgSnapshot':
      return reduceBgSnapshot(ledger, action)
    case 'relayResult':
      return reduceRelayResult(ledger, action, prices)
    case 'editCall': {
      const run = action.loop === undefined ? undefined : getRun(ledger, action.loop)
      return run ? putRun(ledger, { ...run, editCalls: run.editCalls + 1 }) : ledger
    }
    case 'findings':
      return reduceFindings(ledger, action)
    case 'verdict':
      return reduceVerdict(ledger, action)
    case 'clear':
      return reduceClear(ledger)
  }
}

export function totals(ledger: Ledger): Totals {
  const t: Totals = {
    running: 0,
    done: 0,
    failed: 0,
    killed: 0,
    ended: 0,
    unknown: 0,
    usage: { ...ZERO_USAGE },
    cost: null,
    costPartial: false,
    byImplementer: {},
  }
  for (const run of Object.values(ledger.runs)) {
    t[run.status] += 1
    if (run.usage) t.usage = addUsage(t.usage, run.usage)
    if (run.cost !== null) t.cost = (t.cost ?? 0) + run.cost
    if ((run.kind === 'agent' || run.kind === 'relay') && (run.cost === null || run.costPartial)) t.costPartial = true
    t.byImplementer[run.implementer] = (t.byImplementer[run.implementer] ?? 0) + (run.cost ?? 0)
  }
  return t
}
