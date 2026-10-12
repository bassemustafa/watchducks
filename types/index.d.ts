// watchducks state contract: every value the mod keeps in $.state, and the
// shapes its pure modules exchange. Only numbers, identifiers and enums live
// here (spec §2): no prompt, answer, description, command or message text.

export type RunKind = 'agent' | 'relay' | 'cli' | 'shell'

export type Implementer = 'claude-code' | 'claude' | 'opencode' | 'codex' | 'gemini' | 'shell' | 'unknown'

export type RunStatus = 'running' | 'done' | 'failed' | 'killed' | 'ended' | 'unknown'

export type EffortSource = 'observed' | 'reported' | 'flag'

/** Token counts in the native meaning: `uncached` excludes both cache counts. */
export type Usage = { uncached: number; output: number; cacheRead: number; cacheWrite: number }

/** A cost that knows where it came from; `partial` when some requests had no price. */
export type Spend = { usage: Usage; cost: number | null; costPartial: boolean }

/** An explicit review, recorded only through the verdict tool. */
export type Review = { reviewerId: string; bugs: number | null; edits: number | null; source: 'verdict'; at: number }

export type Run = {
  id: string
  kind: RunKind
  codename: string
  implementer: Implementer
  agentType?: string
  lane?: string
  model?: string
  models?: string[]
  effort?: string | number
  effortSource?: EffortSource
  readOnly: boolean
  parentId?: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  durationMs?: number
  usage: Usage | null
  usageSource: 'steps' | 'complete' | 'relay' | 'stats' | 'child' | null
  cost: number | null
  costSource: 'reported' | 'estimated' | null
  costPartial: boolean
  editCalls: number
  bugsReported: number
  reviews: Review[]
  suspectedHandlers: string[]
  /** Short hash of the working directory; live only, never written to history. */
  workdirKey?: string
  /** Background task id from the Bash result, when the run was backgrounded. */
  backgroundTaskId?: string
  /** Resolved relay --out-dir; live only, used to poll result.json after a reload. */
  outDir?: string
  /** True once a relay result.json was applied; live only, so a reload never reads a reused out-dir again. */
  resultRead?: boolean
  /** True when the figures are a best estimate (a stats counter fell, or opencode was used elsewhere in the folder). */
  approx?: boolean
  /** Same-model, same-folder opencode runs share one key; their combined total is counted once. */
  sharedKey?: string
  /** How many runs share `sharedKey`. */
  sharedSize?: number
  /** A Claude child's whole spend by implementer × model, at most 32. */
  rows?: Array<{ implementer: Implementer; model: string; usage: Usage; cost: number | null; costSource: 'reported' | 'estimated' | null }>
}

export type Ledger = {
  v: 1
  /** Bumped by /clear and session changes; async work started under an older one must not write. */
  generation: number
  sessionId: string
  sessionStartedAt: number
  runs: Record<string, Run>
  /** Run ids in creation order (codename collisions resolve in this order). */
  order: string[]
  hq: Spend
  /** The main loop's spend by model (at most 16 models, then `'other'`); live only, never written to history. Absent in state saved before v0.2. */
  hqByModel?: Record<string, Spend>
  overhead: Spend
  /** `${loop}|${turnId}` for every turn that reported step usage (loop = agentId or 'main'). */
  turnsWithSteps: Record<string, true>
  /** `${loop}|${turnId}|${index}` already counted, so a replayed step is not counted twice. */
  countedSteps: Record<string, true>
  /** ReportFindings counts by tool_use_id: { runId, count }. */
  findings: Record<string, { runId: string; count: number }>
  /** Background task ids seen in any snapshot, mapped to their run id. */
  bgSeen: Record<string, string>
  /** Delegated tokens per minute, oldest first, at most 30 entries ending at `seriesEndMinute`. */
  tokenSeries: number[]
  seriesEndMinute: number
  /** History days of runs /clear removed from the live ledger, so the session's record keeps them. */
  retired: HistoryRecord['days']
}

export type View = 'field' | 'station' | 'dossier'

export type UiState = {
  view: View
  dossierId?: string
  span: 'session' | '30d'
  /** True once the person closed the sidebar this session: no more auto-open. */
  closedByPerson: boolean
  autoOpened: boolean
  /** Debrief stamps by run id, each shown on its card until `until` (epoch ms); at most 16, oldest dropped. */
  stamps?: Record<string, { kind: 'done' | 'failed' | 'killed'; until: number }>
}

/** What the Bash classifier extracts (spec §6.2); never the raw command. */
export type Classification =
  | {
      kind: 'relay'
      implementer: 'opencode' | 'claude' | 'codex' | 'gemini' | 'unknown'
      lane?: string
      model?: string
      effort?: string
      readOnly: boolean
      workdir?: string
      outDir?: string
    }
  | { kind: 'cli'; implementer: 'codex' | 'opencode' | 'claude' | 'gemini'; model?: string; effort?: string; workdir?: string }
  | { kind: 'shell'; workdir?: string }

/** The allow-listed projection of a relay result.json (spec §6.3). */
export type RelayProjection = {
  status: RunStatus
  exitCode?: number
  lane?: string
  implementer?: 'opencode' | 'claude' | 'codex' | 'gemini'
  model?: string
  effort?: string
  readOnly: boolean
  startedAt?: number
  finishedAt?: number
  costReported: number | null
  usage: Usage | null
  touchedFiles: number | null
}

/** One station-board row: an implementer × model pair. */
export type StationRow = {
  implementer: Implementer
  model: string
  ops: number
  done: number
  failed: number
  killed: number
  ended: number
  uncached: number
  output: number
  cacheRead: number
  cacheWrite: number
  costReported: number
  costEstimated: number
  unknownCostOps: number
  /** Runs whose token usage is known (`usage !== null`). */
  usageOps: number
  /** Runs whose cost is known (`cost !== null`). */
  costOps: number
  vetted: number
  bugs: number
}

/** One session's history record in $.store under `history/v1/<sessionId>` (spec §5). */
export type HistoryRecord = {
  v: 1
  sessionStartedAt: number
  /** UTC day (YYYY-MM-DD) → `${implementer}|${model}` → counters. */
  days: Record<string, Record<string, Omit<StationRow, 'implementer' | 'model' | 'usageOps' | 'costOps'> & Partial<Pick<StationRow, 'usageOps' | 'costOps'>>>>
}

declare module 'claude-code' {
  interface PluginState {
    watchducks: { ledger: Ledger; ui: UiState }
  }
}
