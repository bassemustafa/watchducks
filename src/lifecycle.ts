import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, FsStat, On, PluginOptions, Timer } from 'claude-code'

import type { HistoryRecord, Ledger, RelayProjection, Run, Usage } from '../types'
import {
  CHILD_ID,
  MAX_REPORTS_LISTED,
  MAX_REPORT_BYTES,
  READ_EVERY_MS,
  REPORT_EVERY_MS,
  STALE_MS,
  buildReport,
  mainModel,
  matchReports,
  projectReport,
  reportDir,
  reportUsage,
  type ChildReport,
} from './adapters/child-report'
import {
  STATS_ARGV,
  STATS_EVERY_MS,
  STATS_MAX_FOLDERS,
  STATS_MAX_RUNS,
  STATS_RACE_MS,
  STATS_TIMEOUT_MS,
  allocate,
  projectStats,
  type Allocation,
  type FolderRun,
  type StatsSnapshot,
} from './adapters/opencode-stats'
import {
  DISCOVERY_BUDGET_MS,
  DISCOVERY_EVERY,
  DiscoveryMemory,
  MATCH_AHEAD_MS,
  MAX_DISCOVERY_READS,
  MAX_DISCOVERY_ROOTS,
  MAX_DISCOVERY_STATS,
  MAX_LISTED_ENTRIES,
  POLL_GRACE_MS,
  RELAY_POLL_MS,
  allowedRoots,
  duePolls,
  fingerprint,
  matchDiscovered,
  pendingDiscovery,
  relayRoots,
  resultPath,
  type FoundResult,
} from './collect/relay'
import { HISTORY_PREFIX, pruneHistory, recordFromLedger } from './history'
import { emptyLedger, isKnownLoop, normalizeDir, reduce, workdirKey, type Action } from './ledger'
import { shownCost, type Pricing } from './cost'
import { LITELLM_URL, PRICES_KEY, ZERO_USAGE, addUsage, fetchedPrices, parsePriceRecord, projectLitellm, type PriceTable } from './price'
import { fnv1a } from './codename'
import { MAX_RESULT_BYTES, ident, isInsideRoots, projectRelayResult, relayIdentity } from './relay-result'
import { INITIAL_LEDGER, INITIAL_UI, isHistoryRecord, pricing, recordsHeadless, withFetched } from './state'
import { ROSTER_SPEC, VERDICT_SPEC } from './tools'
import { blipsFor, radar } from './ui/animate'
import { fmtCost } from './ui/format'
import { BURST_MS, STAMP_MS, TICK_MS, dotFrame, dotRaster, duckPoseAt, motion, stampFrame, stampRaster, tickerValue } from './ui/motion'
import { duckLogo, radarFrame } from './ui/raster'
import { glyphs, statusWords } from './ui/theme'

const ledgerAtom = atom({ plugin: 'watchducks', key: 'ledger' } as const, INITIAL_LEDGER)
const uiAtom = atom({ plugin: 'watchducks', key: 'ui' } as const, INITIAL_UI)

// Session lifecycle (spec §10). A plugin registers `session.start` and
// `session.end` once, and `$` cannot cross an import, so every timer and every
// store write the mod makes lives in this file. Timers sit in module scope: a
// hot reload drops them with the old environment and the next session.start
// starts them again from what `$.state` kept.

const AGENT_POLL_MS = 5000
const SAVE_MS = 60_000

let agentTimer: Timer | undefined
let saveTimer: Timer | undefined
let relayTimer: Timer | undefined
let watchTimer: Timer | undefined
let animTimer: Timer | undefined
let burstTimer: Timer | undefined
let pollingAgents = false
let pollingRelays = false

// bumped by stopTimers: an end step that finds it moved on knows a new session started while it waited
let timersTurn = 0

function stopTimers(): void {
  discoveryPolls = 0
  discoveryGeneration = -1 // the next pass starts with nothing remembered
  resetDiscovery()
  timersTurn += 1
  statsTimer?.cancel()
  statsTimer = undefined
  resetStats() // a process call in flight keeps its lock until it returns, then sees its epoch changed
  resetChild()
  reportsTimer?.cancel()
  reportsTimer = undefined
  reportsBusy = false
  resetReports()
  agentTimer?.cancel()
  saveTimer?.cancel()
  relayTimer?.cancel()
  watchTimer?.cancel()
  animTimer?.cancel()
  burstTimer?.cancel()
  burstTimer = undefined
  motion.tickers = {}
  watchTimer = undefined
  animTimer = undefined
  agentTimer = undefined
  saveTimer = undefined
  relayTimer = undefined
}

async function send($: EngineInterface, action: Action, table: PriceTable): Promise<void> {
  try {
    await update($, ledgerAtom, l => reduce(l, action, table))
  } catch {
    // a failed write never reaches a hook
  }
}

/** True when nothing draws the session (a `-p` run); an error reads as not headless. */
async function isHeadless($: EngineInterface): Promise<boolean> {
  try {
    return (await $.session.surfaces()).length === 0
  } catch {
    return false
  }
}

/** True when the record is stored, or when policy says there is nothing to store; false when the write failed. */
// ---- the daily price refresh (spec §3.9)

const PRICE_DAY_MS = 86_400_000
/** After a failed attempt, and between two looks while a session runs. */
const PRICE_HOUR_MS = 3_600_000
const PRICE_TIMEOUT_MS = 20_000
const PRICE_LOOK_MS = 30_000

const priceReader = fetchedPrices()
let priceLookedAt = Number.NEGATIVE_INFINITY
let priceFlight: Promise<void> | undefined
/** The prices the watch tick works with: re-read from the store at most every PRICE_LOOK_MS. */
let tickPrices: { at: number; pricing: Pricing } | undefined

/** The prices a sink works with: the options', with the refreshed LiteLLM list from the store when there is one. */
async function pricingNow($: EngineInterface, options: PluginOptions): Promise<Pricing> {
  let record: unknown
  try {
    record = await $.store.get(PRICES_KEY)
  } catch {
    // the prices bundled with this version
  }
  return withFetched(pricing(options), priceReader(record))
}

async function pricingTick($: EngineInterface, options: PluginOptions, now: number): Promise<Pricing> {
  if (tickPrices !== undefined && now >= tickPrices.at && now - tickPrices.at < PRICE_LOOK_MS) return tickPrices.pricing
  const fresh = await pricingNow($, options)
  tickPrices = { at: now, pricing: fresh }
  return fresh
}

/**
 * Refreshes the stored LiteLLM price list when it is due: at most once a day, at most one attempt an hour after a failure,
 * never when `priceUpdates` is off or the host asks for no non-essential traffic. One GET with no init; nothing about the
 * user or the session is sent. The answer is projected to numbers and stored; a late or broken one is dropped. Never
 * awaited by a hook; every failure ends quietly with the prices as they were.
 */
function refreshPrices($: EngineInterface, options: PluginOptions): void {
  if (options.priceUpdates === 'off' || priceFlight !== undefined) return
  const flight = (async (): Promise<void> => {
    try {
      const now = await $.clock.now()
      priceLookedAt = now
      if (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) return
      const had = parsePriceRecord(await $.store.get(PRICES_KEY))
      const fresh = had !== null && had.fetchedAt > 0 && had.fetchedAt <= now && now - had.fetchedAt < PRICE_DAY_MS
      const recent = had !== null && had.attemptedAt <= now && now - had.attemptedAt < PRICE_HOUR_MS
      if (fresh || recent) return
      // the attempt is recorded before the request: a crash or a hang still counts, and a store that cannot be written asks nothing
      await $.store.set(PRICES_KEY, { v: 1, fetchedAt: had?.fetchedAt ?? 0, attemptedAt: now, rates: had?.rates ?? {} })
      const got: { text?: string } = {}
      const asking = (async (): Promise<void> => {
        try {
          const answer = await $.http.fetch(LITELLM_URL)
          if (answer.ok && typeof answer.text === 'string') got.text = answer.text
        } catch {
          // refused or failed: the next attempt is an hour away
        }
      })()
      if (!(await within($, asking, PRICE_TIMEOUT_MS)) || got.text === undefined) return
      const rates = projectLitellm(got.text)
      if (rates === null) return
      await $.store.set(PRICES_KEY, { v: 1, fetchedAt: await $.clock.now(), attemptedAt: now, rates })
    } catch {
      // the bundled prices stay
    }
  })().finally(() => {
    if (priceFlight === flight) priceFlight = undefined
  })
  priceFlight = flight
}

async function writeHistory($: EngineInterface, ledger: Ledger, options: PluginOptions): Promise<boolean> {
  if (ledger.sessionId === '') return true
  try {
    if ((await isHeadless($)) && !recordsHeadless(options)) return true
    await $.store.set(HISTORY_PREFIX + ledger.sessionId, recordFromLedger(ledger, await pricingNow($, options)))
    return true
  } catch {
    // history is best effort: a failed write must never reach a hook
    return false
  }
}

async function pruneStoredHistory($: EngineInterface, now: number): Promise<void> {
  try {
    const records: Record<string, HistoryRecord> = {}
    for (const key of await $.store.keys()) {
      if (!key.startsWith(HISTORY_PREFIX)) continue
      const value = await $.store.get(key)
      if (isHistoryRecord(value)) records[key.slice(HISTORY_PREFIX.length)] = value
    }
    const { keep, drop } = pruneHistory(records, now)
    for (const id of drop) await $.store.delete(HISTORY_PREFIX + id)
    for (const [id, record] of Object.entries(keep)) {
      const before = records[id]
      if (before && Object.keys(before.days).length !== Object.keys(record.days).length) {
        await $.store.set(HISTORY_PREFIX + id, record)
      }
    }
  } catch {
    // pruning is housekeeping; the board still works without it
  }
}

async function pollAgents($: EngineInterface, table: PriceTable): Promise<void> {
  if (pollingAgents) return
  pollingAgents = true
  try {
    const seen = await read($, ledgerAtom)
    if (!seen.order.some(id => seen.runs[id]?.kind === 'agent' && seen.runs[id]?.status === 'running')) return
    const listed = await $.agent.list()
    if ((await read($, ledgerAtom)).generation !== seen.generation) return
    const at = Date.now()
    for (const info of listed) {
      const run = isKnownLoop(seen, info.id) ? seen.runs[info.id] : undefined
      if (!run || run.kind !== 'agent') continue
      const s = info.status
      if (s !== 'running' && s !== 'completed' && s !== 'failed' && s !== 'killed') continue
      if (s === 'running' && run.status === 'running') continue
      await send($, { type: 'agentStatus', id: info.id, status: s, at }, table)
    }
  } catch {
    // the next tick tries again
  } finally {
    pollingAgents = false
  }
}

/** The temp root the relay roots and the child reports share: TMPDIR, else /tmp. */
async function tmpRoot($: EngineInterface): Promise<string> {
  try {
    const dir = await $.env.get('TMPDIR')
    if (dir !== undefined && dir !== '') return dir
  } catch {
    // the fixed /tmp root still applies
  }
  return '/tmp'
}

/**
 * The relay roots, each resolved to where it really lands (a root that cannot be resolved is skipped), where the
 * session root landed, and how many `$.fs.stat` calls the resolving took (discovery counts them in its budget).
 */
async function resolvedRoots($: EngineInterface, options: PluginOptions): Promise<{ roots: string[]; session: string; stats: number }> {
  const tmpDir = await tmpRoot($)
  let sessionRoot = ''
  try {
    sessionRoot = await $.session.root()
  } catch {
    // no session root: only the temp roots and the option apply
  }
  const resolved: string[] = []
  let session = ''
  let stats = 0
  for (const root of relayRoots(options, tmpDir, sessionRoot)) {
    stats += 1
    try {
      const stat = await $.fs.stat(root, { resolve: true })
      if (stat.realPath === undefined) continue
      resolved.push(stat.realPath)
      if (sessionRoot !== '' && root === sessionRoot) session = stat.realPath
    } catch {
      // a root that is not there allows nothing
    }
  }
  return { roots: allowedRoots(resolved), session, stats }
}

// A result.json older than the run (a reused --out-dir) belongs to an earlier run.
const STALE_SLACK_MS = 5000

/**
 * The real path of a result.json that may be read: a regular file within the size cap, not older than
 * `notBefore`, whose real path sits under a root. Discovery also refuses a link; an explicit out-dir may be one.
 */
function readablePath(stat: FsStat, notBefore: number, roots: readonly string[], allowLink: boolean): string | null {
  if (stat.kind !== 'file' || stat.size > MAX_RESULT_BYTES) return null
  if (stat.isLink && !allowLink) return null
  if (stat.mtimeMs < notBefore) return null
  const realPath = stat.realPath
  if (realPath === undefined || !isInsideRoots(realPath, roots)) return null
  return realPath
}

/** The real paths the temp root lands on, as roots a file may live under; none when it cannot be resolved. */
async function tempRoots($: EngineInterface, tmpDir: string): Promise<string[]> {
  try {
    const landed = (await $.fs.stat(tmpDir, { resolve: true })).realPath
    return allowedRoots(landed === undefined ? [] : [landed])
  } catch {
    return []
  }
}

/** A report folder may be used (read from, written into) only when it is a real directory, not a link, landing inside the temp root. */
function usableFolder(stat: FsStat, roots: readonly string[]): boolean {
  return stat.kind === 'dir' && !stat.isLink && stat.realPath !== undefined && isInsideRoots(stat.realPath, roots)
}

/** Waits for `work` (which never rejects) for at most `ms`; true when it finished in time. The work itself is not stopped. */
async function within($: EngineInterface, work: Promise<void>, ms: number): Promise<boolean> {
  if (ms <= 0) return false
  let timer: Timer | undefined
  const lapse = new Promise<boolean>(resolve => {
    try {
      timer = $.clock.after(ms, () => resolve(false))
    } catch {
      resolve(false) // without a timer nothing may wait
    }
  })
  const finished = await Promise.race([work.then(() => true), lapse])
  timer?.cancel()
  return finished
}

async function readRelayResult(
  $: EngineInterface,
  outDir: string,
  startedAt: number,
  roots: readonly string[],
): Promise<RelayProjection | null> {
  const realPath = readablePath(await $.fs.stat(resultPath(outDir), { resolve: true }), startedAt - STALE_SLACK_MS, roots, true)
  if (realPath === null) return null
  // the text lives only for this projection: nothing but the allow-listed fields leaves it
  return projectRelayResult(await $.fs.read(realPath))
}

// Discovery state (a relay run with no --out-dir): the polls since a run became pending, and what earlier passes
// learned. Nothing here holds the path of a candidate that was passed over: files and roots are remembered under
// a fingerprint, and only a directory given to a run (stored as its out-dir anyway) is kept by name. All of it is
// dropped when the ledger generation changes, and with a hot reload.
let discoveryPolls = 0
let discoveryGeneration = -1
let claimedDirs = new Set<string>()
// what earlier passes learned (identities, skipped result files, where each root's listing stopped), by fingerprint
const memory = new DiscoveryMemory()
// which root the last pass stopped in
let rootTurn = 0

function resetDiscovery(): void {
  claimedDirs = new Set()
  memory.clear()
  rootTurn = 0
}

/**
 * One pass over the allowed roots for the result.json of relay runs that have no out-dir. Directory names
 * are read only to walk; a candidate is identified by what its result.json says (start, tool, a hash of the
 * working directory), never by its name. A match is read again, must say the same, and is applied at once (its
 * directory becomes the run's out-dir). The home directory is never walked, and a pass stops after 512 fs calls
 * (the root resolving counts) or 2 s.
 */
async function discoverRelays(
  $: EngineInterface,
  seen: Ledger,
  pending: readonly Run[],
  roots: readonly string[],
  session: string,
  rootStats: number,
  table: PriceTable,
): Promise<void> {
  if (seen.generation !== discoveryGeneration) {
    discoveryGeneration = seen.generation
    resetDiscovery()
  }
  const began = Date.now()
  let stats = rootStats
  let reads = 0
  const exhausted = (): boolean => stats >= MAX_DISCOVERY_STATS || Date.now() - began >= DISCOVERY_BUDGET_MS

  // the roots to walk: never the home directory (or the file system root), at most 16
  const dropped = new Set<string>(['/'])
  try {
    const home = await $.env.get('HOME')
    if (home !== undefined && home.startsWith('/')) {
      dropped.add(normalizeDir(home, undefined) ?? '/')
      stats += 1
      try {
        const landed = (await $.fs.stat(home, { resolve: true })).realPath
        if (landed !== undefined) dropped.add(normalizeDir(landed, undefined) ?? '/')
      } catch {
        // the unresolved spelling is still dropped
      }
    }
  } catch {
    // no HOME: nothing more to drop
  }
  const walk: string[] = []
  for (const root of roots) {
    const dir = normalizeDir(root, undefined)
    if (dir === undefined || dropped.has(dir) || walk.includes(dir)) continue
    walk.push(dir)
    if (walk.length >= MAX_DISCOVERY_ROOTS) break
  }
  if (walk.length === 0) return
  const sessionDir = normalizeDir(session, undefined)
  const t0 = Math.min(...pending.map(r => r.startedAt)) - STALE_SLACK_MS

  const statOf = async (target: string, resolve: boolean): Promise<FsStat | null> => {
    if (exhausted()) return null
    stats += 1
    try {
      return await $.fs.stat(target, resolve ? { resolve: true } : undefined)
    } catch {
      return null
    }
  }

  const childDirs = async (dir: string): Promise<string[]> => {
    if (exhausted()) return []
    stats += 1
    try {
      const names: string[] = []
      for (const entry of (await $.fs.list(dir)).slice(0, MAX_LISTED_ENTRIES)) {
        if (entry.kind !== 'dir' || entry.isLink) continue
        if (entry.name === '' || entry.name === '.' || entry.name === '..' || entry.name.includes('/')) continue
        names.push(entry.name)
      }
      return names
    } catch {
      return []
    }
  }

  const found: FoundResult[] = []
  const considerResult = async (dir: string): Promise<void> => {
    const file = dir + '/result.json'
    const stat = await statOf(file, true)
    const realPath = stat === null ? null : readablePath(stat, t0, walk, false)
    if (stat === null || realPath === null) return
    if (memory.isSkipped(file, stat.mtimeMs, stat.size)) return
    try {
      // an unchanged file keeps its identity: it is not read again and does not use up the pass's reads
      let identity = memory.identity(file, stat.mtimeMs, stat.size)
      if (identity === undefined) {
        if (reads >= MAX_DISCOVERY_READS) return
        reads += 1
        // the text lives only for this identification: a start, a tool and a hash leave it
        identity = relayIdentity(await $.fs.read(realPath))
        memory.rememberIdentity(file, stat.mtimeMs, stat.size, identity)
      }
      if (!identity) return
      if (identity.startedAt < t0 - MATCH_AHEAD_MS) {
        memory.skip(file, stat.mtimeMs, stat.size)
        return
      }
      found.push({
        dir,
        startedAt: identity.startedAt,
        ...(identity.tool !== undefined ? { tool: identity.tool } : {}),
        ...(identity.workdirKey !== undefined ? { workdirKey: identity.workdirKey } : {}),
      })
    } catch {
      // unreadable: the next pass tries again
    }
  }

  const visited = new Map<string, boolean>()
  /** True when the directory is a real directory touched since the oldest pending run started; its result.json is then considered. */
  const visit = async (dir: string): Promise<boolean> => {
    const known = visited.get(dir)
    if (known !== undefined) return known
    const stat = await statOf(dir, false)
    const fresh = stat !== null && stat.kind === 'dir' && !stat.isLink && stat.mtimeMs >= t0
    visited.set(dir, fresh)
    if (fresh) await considerResult(dir)
    return fresh
  }

  // Each pass resumes in the root and at the directory where the previous one ran out of budget, so a root
  // with more directories than one pass can look at is still covered over a few passes.
  let stoppedAt = -1
  for (let n = 0; n < walk.length; n++) {
    const turn = (rootTurn + n) % walk.length
    if (exhausted()) {
      stoppedAt = turn
      break
    }
    const root = walk[turn]!
    const names = await childDirs(root)
    const first = names.length === 0 ? 0 : memory.cursor(root) % names.length
    let finished = true
    for (let k = 0; k < names.length; k++) {
      const at = (first + k) % names.length
      if (exhausted()) {
        memory.setCursor(root, at)
        finished = false
        break
      }
      const dir = root + '/' + names[at]!
      const fresh = await visit(dir)
      if (!fresh || root === sessionDir) continue
      for (const inner of await childDirs(dir)) {
        if (exhausted()) break
        await visit(dir + '/' + inner)
      }
    }
    if (!finished) {
      stoppedAt = turn
      break
    }
    memory.setCursor(root, 0)
  }
  rootTurn = stoppedAt < 0 ? 0 : stoppedAt

  const taken = new Set(claimedDirs)
  for (const run of Object.values(seen.runs)) {
    const dir = run.outDir === undefined ? undefined : normalizeDir(run.outDir, undefined)
    if (dir !== undefined) taken.add(dir)
  }
  const byDir = new Map(found.map(f => [f.dir, f] as const))
  const byId = new Map(pending.map(r => [r.id, r] as const))
  for (const { id, outDir } of matchDiscovered(pending, found, taken)) {
    const match = byDir.get(outDir)
    const run = byId.get(id)
    if (!match || !run) continue
    // Between the walk and now the file may have been replaced or swapped for a link: look again, read it once,
    // and apply only if it still says what matched; a failed check applies nothing and the next pass retries.
    let projection: RelayProjection | null = null
    try {
      const stat = await $.fs.stat(match.dir + '/result.json', { resolve: true })
      const realPath = readablePath(stat, run.startedAt - STALE_SLACK_MS, walk, false)
      if (realPath !== null) {
        const text = await $.fs.read(realPath)
        const again = relayIdentity(text)
        if (
          again &&
          again.startedAt === match.startedAt &&
          again.tool === match.tool &&
          again.workdirKey === match.workdirKey
        ) {
          projection = projectRelayResult(text)
        }
      }
    } catch {
      // not confirmed: the next pass tries again
    }
    const result = projection
    if (!result) continue
    // a /clear or a session change while the pass was running: the match belongs to the old ledger, so the
    // generation is checked in the same atomic update that sets the out-dir and applies the result
    let applied = false
    const at = Date.now()
    await update($, ledgerAtom, l => {
      applied = l.generation === seen.generation
      if (!applied) return l
      const found = reduce(l, { type: 'relayFound', id, outDir, at }, table)
      // the run took an out-dir or a result elsewhere meanwhile: this match is not its result
      if (found === l) return l
      return reduce(found, { type: 'relayResult', id, proj: result, at }, table)
    })
    if (!applied) return
    claimedDirs.add(outDir)
  }
}

async function pollRelays($: EngineInterface, table: PriceTable, options: PluginOptions): Promise<void> {
  if (pollingRelays) return
  pollingRelays = true
  try {
    const seen = await read($, ledgerAtom)
    const now = Date.now()
    // a run whose result was applied carries `resultRead`, so duePolls skips it even after a reload
    const due = duePolls(seen, now)
    const pending = pendingDiscovery(seen, now)
    discoveryPolls = pending.length === 0 ? 0 : discoveryPolls + 1
    if (due.length === 0 && pending.length === 0) return
    const { roots, session, stats } = await resolvedRoots($, options)
    // runs with an explicit out-dir first: a slow discovery pass never delays them
    for (const id of due) {
      const run = Object.hasOwn(seen.runs, id) ? seen.runs[id] : undefined
      if (run?.outDir === undefined) continue
      try {
        const projection = await readRelayResult($, run.outDir, run.startedAt, roots)
        if (!projection) continue
        // a /clear or a session change while the read was pending: the result belongs to the old ledger,
        // so the generation is checked in the same atomic update that applies it
        const action: Action = { type: 'relayResult', id, proj: projection, at: Date.now() }
        let applied = false
        await update($, ledgerAtom, l => {
          applied = l.generation === seen.generation
          return applied ? reduce(l, action, table) : l
        })
        if (!applied) return
      } catch {
        // not there yet, unreadable or hostile: the run keeps its status and the next tick tries again
      }
    }
    if (pending.length > 0 && discoveryPolls % DISCOVERY_EVERY === 0) {
      try {
        await discoverRelays($, seen, pending, roots, session, stats, table)
      } catch {
        // the next pass tries again
      }
    }
  } catch {
    // the next tick tries again
  } finally {
    pollingRelays = false
  }
}

// opencode stats (spec §3). While `opencodeStats` is on and an opencode run is pending (running, or ended less than the
// relay grace ago and not yet given its last interval), one timer takes `opencode stats` snapshots per working directory.
// Two consecutive snapshots of a folder bound an interval; `allocate` splits that interval's growth among the runs active
// in it, and every run keeps the sum of its shares. The process runs one at a time for the session, at most once per
// STATS_EVERY_MS per directory; its stdout is projected to numbers by `projectStats` and its stderr is never read. What is
// kept here is numbers and run ids: the working directory is read from a pending run for the call and not kept. The pure
// parts (projection, allocation) are in `adapters/opencode-stats.ts`.

const STATS_SLACK_MS = 50 // a timer tick may land a hair before the interval is over
const STATS_MAX_FAILURES = 3
const STATS_EXIT_TIMEOUT_MS = 3000
const STATS_EXIT_MIN_MS = 250 // a snapshot is not started with less than this left of the exit deadline

/** What a pending run has been given so far: the sum of its shares, and the figures last dispatched to the ledger. */
type StatsAcc = {
  usage: Usage
  cost: number
  approx: boolean
  shared: number
  allocated: boolean
  folder: string
  run: FolderRun
  /** The ledger cleared the run (ended) before its last interval: it stays a member of that interval, unpaid. */
  gone?: boolean
  sent?: { usage: Usage; cost: number; approx: boolean; shared: number }
}
type StatsFolder = { key: string; cwd: string; runs: Run[] }

let statsTimer: Timer | undefined
// single flight: whoever runs the process holds the lock and releases only its own; a session change does not release it
let statsOwner: object | undefined
let statsInflight: Promise<void> | undefined
// set when the session is ending: a tick starts no further process
let statsStopping = false
// session-wide: the failure breaker does not reset with /flock clear
let statsFailures = 0
let statsSession = ''
let statsGeneration = -1
// bumped by a new session: a tick that started under an older one discards what it measured
let statsEpoch = 0
// per pending run, at most STATS_MAX_RUNS
const statsAcc = new Map<string, StatsAcc>()
// per folder with pending runs, at most STATS_MAX_FOLDERS: the last snapshot, and when the process was last called
const statsShots = new Map<string, StatsSnapshot>()
const statsCalled = new Map<string, number>()
// runs given their last interval: they never re-enter, even if their end moves later (ids the ledger still has)
const statsFinalized = new Set<string>()

function resetStats(): void {
  statsEpoch += 1
  statsStopping = false
  statsFinalized.clear()
  statsFailures = 0
  statsSession = ''
  statsGeneration = -1
  statsAcc.clear()
  statsShots.clear()
  statsCalled.clear()
}

/** A new session starts the adapter over; a /flock clear only drops the accumulators of runs the ledger no longer has. */
function syncStatsSession(l: Ledger): void {
  if (l.sessionId !== statsSession) {
    resetStats()
    statsSession = l.sessionId
    statsGeneration = l.generation
    return
  }
  if (l.generation === statsGeneration) return
  statsGeneration = l.generation
  // a clear removes only runs that ended; one that ended after the last look has no end time here, so the clear is it
  const at = Date.now()
  for (const acc of statsAcc.values()) {
    if (Object.hasOwn(l.runs, acc.run.id)) continue
    acc.gone = true
    acc.run = { ...acc.run, endedAt: acc.run.endedAt ?? at }
  }
}

const folderRun = (run: Run): FolderRun => ({ id: run.id, model: run.model, startedAt: run.startedAt, endedAt: run.endedAt })

const isOpencode = (run: Run): boolean => run.implementer === 'opencode' && (run.kind === 'cli' || run.kind === 'relay')

/** An opencode run that stats may still measure: not a child report's, and running or ended less than the grace ago. */
function statsCandidate(run: Run, now: number): boolean {
  if (!isOpencode(run) || run.usageSource === 'child') return false
  if (run.status === 'running') return true
  return run.endedAt !== undefined && now - run.endedAt < POLL_GRACE_MS
}

async function statsRoot($: EngineInterface): Promise<string | undefined> {
  try {
    return normalizeDir(await $.session.root(), undefined)
  } catch {
    return undefined
  }
}

/** `at` is the request time: taken before the process is asked, so everything the snapshot holds was there at or after it. */
async function takeStats($: EngineInterface, cwd: string, timeoutMs: number): Promise<StatsSnapshot | null> {
  try {
    const at = Date.now()
    const r = await $.process.run(STATS_ARGV, { cwd, timeoutMs })
    if (r.exitCode !== 0 || r.isStdoutTruncated) return null
    return projectStats(r.stdout, at)
  } catch {
    return null
  }
}

/**
 * The pending runs by folder (the directory the process runs in). A run that ended is pending while it has an
 * accumulator, or while the folder's snapshot is older than its end (the next interval holds its last growth). A run
 * not yet seen is admitted with an accumulator, up to STATS_MAX_RUNS; one beyond the cap is left out and shows "—".
 * A run without a working directory whose directory key is another folder's (a restored run) cannot be measured.
 */
function statsFolders(l: Ledger, root: string | undefined, now: number): Map<string, StatsFolder> {
  const folders = new Map<string, StatsFolder>()
  for (const id of [...statsFinalized]) if (!Object.hasOwn(l.runs, id)) statsFinalized.delete(id)
  for (const id of l.order) {
    const run = Object.hasOwn(l.runs, id) ? l.runs[id] : undefined
    if (!run || statsFinalized.has(id) || !statsCandidate(run, now)) continue
    const cwd = run.workdir ?? root
    if (cwd === undefined) continue
    if (run.workdir === undefined && run.workdirKey !== undefined && run.workdirKey !== workdirKey(cwd)) continue
    const key = workdirKey(cwd)
    if (run.status !== 'running' && !statsAcc.has(id)) {
      const shot = statsShots.get(key)
      if (shot === undefined || run.endedAt === undefined || shot.at >= run.endedAt) continue
    }
    const acc = statsAcc.get(id)
    if (acc) {
      acc.folder = key
      acc.run = folderRun(run)
    } else {
      if (statsAcc.size >= STATS_MAX_RUNS) continue
      statsAcc.set(id, { usage: { ...ZERO_USAGE }, cost: 0, approx: false, shared: 1, allocated: false, folder: key, run: folderRun(run) })
    }
    const folder = folders.get(key)
    if (folder) folder.runs.push(run)
    else folders.set(key, { key, cwd, runs: [run] })
  }
  // a folder whose every pending run is settled has nothing to measure: no snapshot could change what its runs show
  for (const [key, folder] of folders) if (folder.runs.every(isSettled)) folders.delete(key)
  return folders
}

/** Exact usage and a reported cost came from a relay result: no stats figure replaces either (a neighbour still needs it as a member). */
const isSettled = (run: Run): boolean => run.usageSource === 'relay' && run.costLocked === 'relay'

/** Folders without a snapshot first, then the oldest snapshot. */
function statsOrder(folders: ReadonlyMap<string, StatsFolder>): StatsFolder[] {
  const age = (f: StatsFolder): number => statsShots.get(f.key)?.at ?? -Infinity
  return [...folders.values()].sort((a, b) => age(a) - age(b))
}

const sameSent = (a: NonNullable<StatsAcc['sent']>, b: StatsAcc): boolean =>
  a.usage.uncached === b.usage.uncached &&
  a.usage.output === b.usage.output &&
  a.usage.cacheRead === b.usage.cacheRead &&
  a.usage.cacheWrite === b.usage.cacheWrite &&
  a.cost === b.cost &&
  a.approx === b.approx &&
  a.shared === b.shared

/**
 * Takes `cur` as the folder's newest snapshot: the interval since the one before it is allocated to the pending runs
 * active in it, and the runs whose figures changed get them in one atomic ledger update. A run is final once an interval
 * that ended at or after its end has been allocated: it is dispatched once more and its accumulator is dropped.
 */
async function applyStats(
  $: EngineInterface,
  table: PriceTable,
  sessionId: string,
  epoch: number,
  key: string,
  root: string | undefined,
  cur: StatsSnapshot,
): Promise<void> {
  const l = await read($, ledgerAtom)
  if (epoch !== statsEpoch || l.sessionId !== sessionId) return
  const now = Date.now()
  const folder = statsFolders(l, root, now).get(key)
  const prev = statsShots.get(key)
  if (!folder) {
    statsShots.delete(key)
    return
  }
  statsShots.set(key, cur)
  const given = new Map<string, Allocation>()
  // runs the ledger cleared before their last interval still take their part of it, so no neighbour absorbs it
  const ghosts = [...statsAcc].filter(([, a]) => a.gone && a.folder === key)
  if (prev !== undefined) {
    const runs: FolderRun[] = [...folder.runs.map(folderRun), ...ghosts.map(([, a]) => a.run)]
    for (const a of allocate(prev, cur, runs)) given.set(a.id, a)
  }

  const actions: Action[] = []
  const sending: Array<[StatsAcc, NonNullable<StatsAcc['sent']>]> = []
  const finished: string[] = []
  for (const run of folder.runs) {
    const acc = statsAcc.get(run.id)
    if (!acc) continue
    const share = given.get(run.id)
    if (share) {
      // the run's first interval opens at a snapshot requested late: what happened before it is not measured
      const late = !acc.allocated && prev !== undefined && prev.at > run.startedAt + STATS_RACE_MS
      acc.usage = addUsage(acc.usage, share.usage)
      acc.cost += share.cost
      acc.approx = acc.approx || share.approx || late
      acc.shared = Math.max(acc.shared, share.shared)
      acc.allocated = true
    }
    const over = run.endedAt !== undefined && cur.at >= run.endedAt
    if (over) finished.push(run.id)
    if (over && !acc.allocated) continue // ended before the folder's first snapshot: nothing to show
    const nothing = acc.cost === 0 && totalOf(acc.usage) === 0
    if (acc.sent && sameSent(acc.sent, acc)) continue
    if (nothing && !over) continue
    actions.push({
      type: 'adapterUsage',
      id: run.id,
      source: 'stats',
      usage: acc.usage,
      cost: acc.cost,
      costSource: 'reported',
      ...(acc.approx ? { approx: true } : {}),
      ...(acc.shared > 1 ? { sharedSize: acc.shared } : {}),
      at: now,
    })
    sending.push([acc, { usage: acc.usage, cost: acc.cost, approx: acc.approx, shared: acc.shared }])
  }

  let applied = actions.length === 0
  if (actions.length > 0) {
    await update($, ledgerAtom, cur => {
      applied = cur.sessionId === sessionId
      return applied ? actions.reduce((acc, a) => reduce(acc, a, table), cur) : cur
    })
  }
  if (epoch !== statsEpoch) return
  if (applied) for (const [acc, sent] of sending) acc.sent = sent
  for (const id of finished) {
    statsAcc.delete(id)
    statsFinalized.add(id)
  }
  for (const [id, acc] of ghosts) if (acc.run.endedAt === undefined || cur.at >= acc.run.endedAt) statsAcc.delete(id)
}

const totalOf = (u: Usage): number => u.uncached + u.output + u.cacheRead + u.cacheWrite

async function statsTick($: EngineInterface, table: PriceTable, options: PluginOptions): Promise<void> {
  if (statsOwner || options.opencodeStats !== 'on') return
  const me = {}
  statsOwner = me
  const work = (async (): Promise<void> => {
    try {
      const seen = await read($, ledgerAtom)
      syncStatsSession(seen)
      if (statsFailures >= STATS_MAX_FAILURES) return
      const epoch = statsEpoch
      const root = await statsRoot($)
      // the engine's clock paces the snapshots; run times are wall-clock like the rest of the ledger
      const clockNow = await $.clock.now()
      if (epoch !== statsEpoch) return
      const now = Date.now()
      const folders = statsFolders(seen, root, now)
      const pending = new Set<string>()
      for (const folder of folders.values()) for (const run of folder.runs) pending.add(run.id)
      for (const [id, acc] of [...statsAcc]) {
        const stale = acc.gone ? !folders.has(acc.folder) || now - (acc.run.endedAt ?? 0) >= POLL_GRACE_MS : !pending.has(id)
        if (stale) statsAcc.delete(id)
      }
      for (const key of [...statsShots.keys()]) if (!folders.has(key)) statsShots.delete(key)
      for (const [key, at] of [...statsCalled]) if (clockNow - at >= STATS_EVERY_MS - STATS_SLACK_MS) statsCalled.delete(key)
      for (const folder of statsOrder(folders)) {
        if (statsStopping) return // the session is ending: its exit step takes the last snapshots
        // one call per folder per pace, never more; a folder past the cap waits for room
        if (statsCalled.has(folder.key) || statsCalled.size >= STATS_MAX_FOLDERS) continue
        if (!statsShots.has(folder.key) && statsShots.size >= STATS_MAX_FOLDERS) continue
        statsCalled.set(folder.key, await $.clock.now())
        const snap = await takeStats($, folder.cwd, STATS_TIMEOUT_MS)
        if (epoch !== statsEpoch) return
        if (snap === null) {
          statsFailures += 1
          if (statsFailures >= STATS_MAX_FAILURES) {
            statsTimer?.cancel()
            statsTimer = undefined
            return
          }
          continue
        }
        statsFailures = 0
        await applyStats($, table, seen.sessionId, epoch, folder.key, root, snap)
        if (epoch !== statsEpoch) return
      }
    } catch {
      // the next tick tries again
    } finally {
      if (statsOwner === me) statsOwner = undefined
    }
  })()
  statsInflight = work
  await work
  if (statsInflight === work) statsInflight = undefined
}

/** What the end hook knows of the session it is ending, taken before it awaits anything. */
type StatsExit = { sessionId: string; epoch: number; deadline: number }

/**
 * The first thing the end hook does: remembers which session and epoch are ending and when the whole step must be over
 * (STATS_EXIT_TIMEOUT_MS, or less when `ms` is all the end step has left), and tells ticks to start no further process.
 * Nothing here awaits.
 */
function beginStatsExit(ms: number): StatsExit {
  statsStopping = true
  return { sessionId: statsSession, epoch: statsEpoch, deadline: Date.now() + Math.min(STATS_EXIT_TIMEOUT_MS, Math.max(0, ms)) }
}

/**
 * Before the session ends, within one deadline of STATS_EXIT_TIMEOUT_MS for the whole step: the tick in flight is awaited
 * and applied, then one snapshot per folder that has an ended pending run (the pace ignored), so the history keeps their
 * last growth. A failure leaves the last live figures. When the deadline wins, the epoch moves on so nothing the step
 * started can dispatch later; a session that changed in the meantime is never touched.
 */
async function finalStats($: EngineInterface, table: PriceTable, options: PluginOptions, exit: StatsExit): Promise<void> {
  try {
    if (options.opencodeStats !== 'on' || exit.deadline - Date.now() <= 0) return
    let timer: Timer | undefined
    let expired = false
    const lapse = new Promise<void>(resolve => {
      try {
        timer = $.clock.after(Math.max(0, exit.deadline - Date.now()), () => {
          expired = true
          resolve()
        })
      } catch {
        // without a timer the step is bounded by its calls' own timeouts
      }
    })
    await Promise.race([exitSnapshots($, table, exit), lapse])
    timer?.cancel()
    if (expired && exit.epoch === statsEpoch) statsEpoch += 1
  } catch {
    // the history keeps the last live figures
  } finally {
    statsStopping = false
  }
}

async function exitSnapshots($: EngineInterface, table: PriceTable, exit: StatsExit): Promise<void> {
  try {
    if (statsInflight) await statsInflight
  } catch {
    return
  }
  if (exit.epoch !== statsEpoch || statsOwner) return
  const me = {}
  statsOwner = me
  try {
    const seen = await read($, ledgerAtom)
    if (seen.sessionId !== exit.sessionId || exit.epoch !== statsEpoch) return
    if (statsFailures >= STATS_MAX_FAILURES) return
    const root = await statsRoot($)
    if (exit.epoch !== statsEpoch) return
    const folders = statsFolders(seen, root, Date.now())
    for (const folder of statsOrder(folders)) {
      if (!statsShots.has(folder.key) || !folder.runs.some(r => r.status !== 'running')) continue
      const remaining = exit.deadline - Date.now()
      if (remaining < STATS_EXIT_MIN_MS) break
      const snap = await takeStats($, folder.cwd, remaining)
      if (exit.epoch !== statsEpoch) return
      if (snap === null) continue
      await applyStats($, table, exit.sessionId, exit.epoch, folder.key, root, snap)
      if (exit.epoch !== statsEpoch) return
    }
  } catch {
    // the history keeps the last live figures
  } finally {
    if (statsOwner === me) statsOwner = undefined
  }
}

/** Called by the watch tick: the stats timer exists while the setting is on and an opencode run may need a snapshot; a run not seen yet is looked at at once. */
function watchStats($: EngineInterface, table: PriceTable, options: PluginOptions, l: Ledger, now: number): void {
  syncStatsSession(l)
  const wanted: Run[] = []
  if (options.opencodeStats === 'on' && statsFailures < STATS_MAX_FAILURES) {
    for (const id of l.order) {
      const run = Object.hasOwn(l.runs, id) ? l.runs[id] : undefined
      if (!run || !statsCandidate(run, now)) continue
      if (run.status === 'running' || statsAcc.has(id) || statsShots.size > 0) wanted.push(run)
    }
  }
  if (wanted.length === 0) {
    statsTimer?.cancel()
    statsTimer = undefined
    return
  }
  if (!statsTimer) statsTimer = $.clock.every(STATS_EVERY_MS, () => void statsTick($, table, options))
  if (statsAcc.size < STATS_MAX_RUNS && wanted.some(r => r.status === 'running' && !statsAcc.has(r.id))) void statsTick($, table, options)
}

// Claude child report (spec §4). A session started from another session's agent shell inherits that parent's
// CLAUDE_CODE_SESSION_ID; it then writes its numbers-only spend into a folder named by a hash of the parent's id, once at
// start, every REPORT_EVERY_MS while the report changed, and finally at session end. Every write is best effort, goes
// into a folder that is a real directory inside the temp root, and is waited for at most CHILD_BOUND_MS by a hook.

const CHILD_BOUND_MS = 1000
// kept back from the end hook's budget for the history write, which is never skipped
const END_RESERVE_MS = 500

type ChildMode = {
  path: string
  dir: string
  tmpDir: string
  /** The session this child mode was started for: a write that finds the ledger on another session writes nothing. */
  sessionId: string
  startedAt: number
  workdirKey: string | undefined
  /** The settings the report's costs are shown under (read again at each write, with the refreshed prices). */
  options: PluginOptions
  /** The last report written, `updatedAt` removed: a tick whose text equals it writes nothing. */
  last: string
  /** The write in flight, so ticks never overlap and the final write follows it. */
  flight: Promise<void> | undefined
  timer: Timer | undefined
}

let child: ChildMode | undefined

function resetChild(): void {
  child?.timer?.cancel()
  child = undefined
}

function withoutStamp(text: string): string {
  return text.replace(/"updatedAt":"[^"]*",/, '')
}

/**
 * A folder that is not there yet is created by the write; one that is there must be usable (a real directory inside the
 * temp root, not a link), else nothing is written into it. A stat that finds nothing at the path, whether it rejects or
 * answers `other` for something that is not a link, counts as not there.
 */
async function childFolderUsable($: EngineInterface, c: ChildMode): Promise<boolean> {
  let folder: FsStat
  try {
    folder = await $.fs.stat(c.dir, { resolve: true })
  } catch {
    return true
  }
  if (folder.kind === 'other' && !folder.isLink) return true
  return usableFolder(folder, await tempRoots($, c.tmpDir))
}

/** One report write; a failed one leaves `last` as it was, so the next tick tries again. */
async function writeChild($: EngineInterface, c: ChildMode, status: ChildReport['status']): Promise<void> {
  try {
    const ledger = await read($, ledgerAtom)
    if (ledger.sessionId !== c.sessionId) return // a pending write of an older session builds nothing from the new one
    const text = buildReport(ledger, c.startedAt, c.workdirKey, status, Date.now(), await pricingNow($, c.options))
    const signature = withoutStamp(text)
    if (signature === c.last) return
    if (!(await childFolderUsable($, c))) return
    await $.fs.write(c.path, text)
    c.last = signature
  } catch {
    // the report is a courtesy to the parent: a failed write never reaches a hook
  }
}

function flightOf($: EngineInterface, c: ChildMode, status: ChildReport['status'] = 'running'): Promise<void> {
  const flight = writeChild($, c, status).finally(() => {
    if (c.flight === flight) c.flight = undefined
  })
  c.flight = flight
  return flight
}

async function startChild($: EngineInterface, options: PluginOptions): Promise<void> {
  resetChild()
  if (options.reportToParent === 'off') return
  try {
    const parentId = ident(await $.env.get('CLAUDE_CODE_SESSION_ID'))
    const ownId = await $.session.id()
    if (parentId === undefined || !CHILD_ID.test(ownId) || parentId === ownId) return
    let key: string | undefined
    try {
      const dir = normalizeDir(await $.session.root(), undefined)
      if (dir !== undefined && dir !== '') key = workdirKey(dir)
    } catch {
      // no session root: the report carries no folder key
    }
    const tmpDir = await tmpRoot($)
    const dir = reportDir(tmpDir, parentId)
    const c: ChildMode = {
      path: `${dir}/${ownId}.json`,
      dir,
      tmpDir,
      sessionId: ownId,
      startedAt: (await read($, ledgerAtom)).sessionStartedAt,
      workdirKey: key,
      options,
      last: '',
      flight: undefined,
      timer: undefined,
    }
    child = c
    // the start hook waits for the first write for a moment only; a write left behind keeps the ticks from starting another
    await within($, flightOf($, c), CHILD_BOUND_MS)
    if (child === c) c.timer = $.clock.every(REPORT_EVERY_MS, () => (child === c && !c.flight ? void flightOf($, c) : undefined))
  } catch {
    // no child mode: the session works as any other
  }
}

/**
 * The end of a child session, within `ms` (at most CHILD_BOUND_MS): stop the timer, let a write in flight land, then the
 * final report. A write that is still pending at the bound is not followed by another.
 */
async function finishChild($: EngineInterface, ms: number): Promise<void> {
  const c = child
  if (!c) return
  child = undefined
  c.timer?.cancel()
  const deadline = Date.now() + Math.min(ms, CHILD_BOUND_MS)
  if (c.flight && !(await within($, c.flight, deadline - Date.now()))) return
  // the end event carries no error reason (clear, resume, logout, prompt_input_exit, other): the status is always done
  await within($, flightOf($, c, 'done'), deadline - Date.now())
}

// Claude child reports, parent side (spec §4.5–4.9). While a `cli` or `relay` run of a Claude (or of an unattributed tool)
// is running or ended less than the relay grace ago, one timer lists the parent's own report folder every READ_EVERY_MS.
// The folder must be a real directory inside the temp root; each file is checked like a relay result (regular, not a link,
// within the size cap, real path inside the temp root), read only when its mtime or size changed, projected through the
// allow-list, and matched to a run once. The match is stored on the run (`childId`, `childStartedAt`), so it survives a
// reload; from then on the file belongs to that run and every change of it updates the run. All of a poll's updates go in
// one atomic ledger write. What is kept here: file names (child session ids) bound to run ids, the names of files whose
// run /flock clear removed (their claim outlives the run), and fingerprints of the files already handled.

const REPORT_SUFFIX = '.json'

let reportsTimer: Timer | undefined
let reportsBusy = false
let reportsSession = ''
// bumped by a new session and by stopTimers: a poll that started under an older one discards what it read
let reportsEpoch = 0
type Bound = { id: string; startedAt: number | undefined }
// report file name -> the run it belongs to and the start it was matched with; rebuilt from the ledger at every sync,
// at most MAX_REPORTS_LISTED: a full map refuses a new binding
const reportBound = new Map<string, Bound>()
// files whose run left the ledger (/flock clear): still claimed, so no other run takes them; at most MAX_REPORTS_LISTED,
// and once full a further one cannot be remembered, so nothing new is matched for the rest of the session
const reportCleared = new Set<string>()
let reportsFull = false
// the files already handled, by fingerprint of the name, valid while their mtime and size stay the same
const reportMemory = new DiscoveryMemory()

function resetReports(): void {
  reportsEpoch += 1
  reportsSession = ''
  reportBound.clear()
  reportCleared.clear()
  reportsFull = false
  reportMemory.clear()
}

/** The binding map as the ledger holds it: a new session starts over; a file whose run is gone keeps its claim. */
function syncReportsSession(l: Ledger): void {
  if (l.sessionId !== reportsSession) {
    resetReports()
    reportsSession = l.sessionId
  }
  const held = new Map<string, Bound>()
  for (const id of l.order) {
    const run = Object.hasOwn(l.runs, id) ? l.runs[id] : undefined
    if (run?.childId === undefined || held.size >= MAX_REPORTS_LISTED) continue
    held.set(run.childId + REPORT_SUFFIX, { id, startedAt: run.childStartedAt })
  }
  for (const file of reportBound.keys()) {
    if (held.has(file)) continue
    if (reportCleared.size < MAX_REPORTS_LISTED) reportCleared.add(file)
    else reportsFull = true
  }
  reportBound.clear()
  for (const [file, bound] of held) reportBound.set(file, bound)
}

/** A run whose child may write a report: a Claude (or not yet attributed) `cli` or `relay`, running or ended less than the grace ago. */
function reportCandidate(run: Run, now: number): boolean {
  if (run.kind !== 'cli' && run.kind !== 'relay') return false
  if (run.implementer !== 'claude' && run.implementer !== 'unknown') return false
  if (run.status === 'running') return true
  return run.endedAt !== undefined && now - run.endedAt < POLL_GRACE_MS
}

function reportCandidates(l: Ledger, now: number): Run[] {
  const out: Run[] = []
  for (const id of l.order) {
    const run = Object.hasOwn(l.runs, id) ? l.runs[id] : undefined
    if (run && reportCandidate(run, now)) out.push(run)
  }
  return out
}

/** The name of a listed entry that may be a report: a plain file `<child id>.json`. */
function reportFile(entry: FsEntry): string | null {
  if (entry.kind !== 'file' || entry.isLink || !entry.name.endsWith(REPORT_SUFFIX)) return null
  return CHILD_ID.test(entry.name.slice(0, -REPORT_SUFFIX.length)) ? entry.name : null
}

/** What a report gives its run: the sum of its rows, the child's main model, its rows, its end when it has one, and the file it is. */
function childAction(id: string, file: string, report: ChildReport, at: number): Action {
  const { usage, cost, costSource } = reportUsage(report)
  const model = mainModel(report)
  return {
    type: 'adapterUsage',
    id,
    source: 'child',
    usage,
    cost,
    costSource,
    ...(model !== undefined ? { model } : {}),
    rows: report.rows,
    ...(report.status !== 'running' ? { status: report.status } : {}),
    childId: file.slice(0, -REPORT_SUFFIX.length),
    childStartedAt: report.startedAt,
    at,
  }
}

type ReportRead = { file: string; report: ChildReport; mtimeMs: number; size: number }

async function pollReports($: EngineInterface, table: PriceTable): Promise<void> {
  if (reportsBusy) return
  reportsBusy = true
  try {
    const seen = await read($, ledgerAtom)
    syncReportsSession(seen)
    const epoch = reportsEpoch
    const live = reportCandidates(seen, Date.now())
    if (live.length === 0) return
    const tmpDir = await tmpRoot($)
    const dir = reportDir(tmpDir, await $.session.id())
    // the folder is looked at before it is listed: most sessions have no child that reports, and a folder that is
    // missing, a link, or lands outside the temp root is not listed. Only names that can be reports count toward the cap.
    const files: string[] = []
    let roots: string[]
    try {
      const folder = await $.fs.stat(dir, { resolve: true })
      roots = await tempRoots($, tmpDir)
      if (!usableFolder(folder, roots)) return
      for (const entry of (await $.fs.list(dir)).slice(0, MAX_LISTED_ENTRIES)) {
        const file = reportFile(entry)
        if (file === null) continue
        files.push(file)
        if (files.length >= MAX_REPORTS_LISTED) break
      }
    } catch {
      return // no folder yet, or it cannot be listed: the next poll tries again
    }
    if (files.length === 0) return

    const changed: ReportRead[] = []
    const invalid: Array<[string, number, number]> = []
    for (const file of files) {
      if (reportCleared.has(file)) continue // its run is gone: nothing is read for it
      try {
        const stat = await $.fs.stat(`${dir}/${file}`, { resolve: true })
        const realPath = readablePath(stat, Date.now() - STALE_MS, roots, false)
        if (realPath === null || stat.size > MAX_REPORT_BYTES) continue
        if (reportMemory.identity(file, stat.mtimeMs, stat.size) !== undefined) continue
        // the text lives only for this projection: nothing but the allow-listed fields leaves it
        const report = projectReport(await $.fs.read(realPath), Date.now())
        if (report === null) invalid.push([file, stat.mtimeMs, stat.size])
        else changed.push({ file, report, mtimeMs: stat.mtimeMs, size: stat.size })
      } catch {
        // unreadable: the next poll tries again
      }
    }
    if (epoch !== reportsEpoch) return

    // bound files keep updating their run; the others are matched to the runs that have no file yet
    const claimed = new Set<string>([...reportBound.keys(), ...reportCleared])
    const taken = new Set([...reportBound.values()].map(b => b.id))
    const fresh = reportsFull ? [] : changed.filter(r => !claimed.has(r.file))
    const room = Math.max(0, MAX_REPORTS_LISTED - reportBound.size)
    const binding = matchReports(
      live.filter(run => !taken.has(run.id)),
      fresh,
      claimed,
    ).slice(0, room)
    const owner = new Map<string, Bound>(reportBound)
    for (const m of binding) owner.set(m.file, { id: m.id, startedAt: changed.find(r => r.file === m.file)?.report.startedAt })
    const at = Date.now()
    const actions: Action[] = []
    const sent: ReportRead[] = []
    for (const r of changed) {
      const bound = owner.get(r.file)
      if (bound === undefined) continue
      // a file that now says another start is not the child this run was matched with
      if (bound.startedAt !== undefined && bound.startedAt !== r.report.startedAt) {
        invalid.push([r.file, r.mtimeMs, r.size])
        continue
      }
      actions.push(childAction(bound.id, r.file, r.report, at))
      sent.push(r)
    }

    let applied = actions.length === 0
    if (actions.length > 0) {
      await update($, ledgerAtom, cur => {
        applied = cur.sessionId === seen.sessionId
        return applied ? actions.reduce((acc, a) => reduce(acc, a, table), cur) : cur
      })
    }
    if (epoch !== reportsEpoch || !applied) return
    for (const m of binding) reportBound.set(m.file, owner.get(m.file)!)
    for (const [file, mtimeMs, size] of invalid) reportMemory.rememberIdentity(file, mtimeMs, size, null)
    for (const r of sent) reportMemory.rememberIdentity(r.file, r.mtimeMs, r.size, null)
  } catch {
    // the next poll tries again
  } finally {
    reportsBusy = false
  }
}

/** The poll before the session ends, within `ms` (at most CHILD_BOUND_MS) and only when none is in flight; a poll left behind dispatches nothing. */
async function finalReports($: EngineInterface, table: PriceTable, ms: number): Promise<void> {
  if (ms <= 0 || reportsBusy) return
  if (!(await within($, pollReports($, table), Math.min(ms, CHILD_BOUND_MS)))) reportsEpoch += 1
}

/** Called by the watch tick: the timer exists only while a run may still get a report. */
function watchReports($: EngineInterface, table: PriceTable, l: Ledger, now: number): void {
  syncReportsSession(l)
  if (reportCandidates(l, now).length === 0) {
    reportsTimer?.cancel()
    reportsTimer = undefined
    return
  }
  if (!reportsTimer) reportsTimer = $.clock.every(READ_EVERY_MS, () => void pollReports($, table))
}

async function saveWhileActive($: EngineInterface, options: PluginOptions): Promise<void> {
  try {
    // a session left open for days looks again about once an hour (the refresh itself decides whether it is due)
    if (options.priceUpdates !== 'off' && (await $.clock.now()) - priceLookedAt >= PRICE_HOUR_MS) refreshPrices($, options)
    const l = await read($, ledgerAtom)
    if (!l.order.some(id => l.runs[id]?.status === 'running')) return
    await saveHistory($, options, true)
  } catch {
    // best effort
  }
}

// UI timers (spec §9.2, §9.4). One watch timer sees every run change in the
// ledger (the collectors write it, this file only reads): it stamps a run that
// turned done, toasts a run that ended, auto-opens the sidebar on the first run
// of the session, and starts or stops the 200 ms animation timer. Module state
// dies with a hot reload; session.start seeds it again from the ledger so no
// old run is stamped or toasted twice.

const WATCH_MS = 500
const ANIM_MS = 200
const HISTORY_DELAY_MS = 2000
const PANE = 'flock'

let watching = false
let animating = false
let watchCount = 0
let seenGeneration = -1
let seenSession = ''
const seenStatus = new Map<string, string>()
// the totals each running card last had, so a change counts up from there
const seenTotals = new Map<string, { tokens: number; cost: number | null }>()

/** One redraw timer for all count-ups (at most ~15 redraws a second); it stops itself when the last ticker has finished. */
function startBurst($: EngineInterface): void {
  if (burstTimer) return
  burstTimer = $.clock.every(BURST_MS, () => {
    const now = Date.now()
    for (const [id, t] of Object.entries(motion.tickers)) if (now - t.startedAt >= TICK_MS) delete motion.tickers[id]
    $.ui.invalidate('ui.render')
    if (Object.keys(motion.tickers).length === 0) stopBurst()
  })
}

function stopBurst(): void {
  burstTimer?.cancel()
  burstTimer = undefined
}

/** Compare a running run's totals with the last seen ones and (re)start its count-up; true when a ticker was set. */
function trackTotals(run: Run, now: number, pr: Pricing): boolean {
  const tokens = run.usage ? run.usage.uncached + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite : 0
  // the count-up runs on the cost the card shows
  const cost = shownCost(run, pr.mode, pr.table, pr.fetched).cost
  const prev = seenTotals.get(run.id)
  seenTotals.set(run.id, { tokens, cost })
  if (!prev || (prev.tokens === tokens && prev.cost === cost)) return false
  const shown = Object.hasOwn(motion.tickers, run.id) ? tickerValue(motion.tickers[run.id]!, now) : { tokens: prev.tokens, cost: prev.cost ?? 0 }
  motion.tickers[run.id] = { fromTokens: shown.tokens, toTokens: tokens, fromCost: shown.cost, toCost: cost ?? shown.cost, startedAt: now }
  return true
}
let historyPending = false
// history saves run one at a time; a change that arrives while one is in flight is saved right after it
let saving = false
let dirtyAgain = false
// what the last successful save stored; a hot reload drops it, so the first watch tick saves once
let savedSignature: string | undefined

function seed(l: Ledger): void {
  seenGeneration = l.generation
  seenSession = l.sessionId
  motion.seed = fnv1a(l.sessionId)
  seenStatus.clear()
  seenTotals.clear()
  motion.tickers = {}
  for (const id of l.order) {
    const run = Object.hasOwn(l.runs, id) ? l.runs[id] : undefined
    if (!run) continue
    seenStatus.set(id, run.status)
  }
}

/** The session id and the record's day buckets (counts only): it changes whenever the stored record would. */
function historySignature(l: Ledger, pr: Pricing): { signature: string; empty: boolean } {
  const days = JSON.stringify(recordFromLedger(l, pr).days)
  return { signature: `${l.sessionId}|${days}`, empty: days === '{}' }
}

/** One history write at most every 2 s: a run that ended, got usage or cost, or was reviewed between the 60 s saves is kept at once. */
function scheduleHistoryWrite($: EngineInterface, options: PluginOptions): void {
  if (historyPending) return
  historyPending = true
  $.clock.after(HISTORY_DELAY_MS, () => void flushHistory($, options))
}

async function flushHistory($: EngineInterface, options: PluginOptions): Promise<void> {
  historyPending = false
  await saveHistory($, options, false)
}

/** Saves never overlap; `force` writes even when the record is unchanged since the last save. */
async function saveHistory($: EngineInterface, options: PluginOptions, force: boolean): Promise<void> {
  if (saving) {
    dirtyAgain = true
    return
  }
  saving = true
  try {
    const ledger = await read($, ledgerAtom)
    const { signature } = historySignature(ledger, await pricingNow($, options))
    if (force || signature !== savedSignature) {
      if (await writeHistory($, ledger, options)) savedSignature = signature
    }
  } catch {
    // best effort
  } finally {
    saving = false
    if (dirtyAgain) {
      dirtyAgain = false
      scheduleHistoryWrite($, options)
    }
  }
}

async function clearStamp($: EngineInterface, runId: string): Promise<void> {
  try {
    await update($, uiAtom, u => {
      if (!u.stamps || !Object.hasOwn(u.stamps, runId)) return u
      const { [runId]: _gone, ...left } = u.stamps
      if (Object.keys(left).length === 0) {
        const { stamps: _stamps, ...rest } = u
        return rest
      }
      return { ...u, stamps: left }
    })
  } catch {
    // a stale stamp is ignored by the render once its time has passed
  }
}

async function flockPlaced($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
  } catch {
    return false
  }
}

async function blit1($: EngineInterface, key: string, cells: string): Promise<void> {
  try {
    await $.ui.blit({ requestId: PANE, key, cells })
  } catch {
    // a missed frame is not an error
  }
}

async function drawMotion($: EngineInterface, options: PluginOptions): Promise<void> {
  if (animating) return
  animating = true
  try {
    const now = Date.now()
    const m = radar.mounted
    if (m) {
      radar.tick = (radar.tick + 1) % 48
      await blit1($, 'radar', radarFrame(radar.tick, radar.blips, m.columns, m.rows).cells)
    }
    const dot = dotFrame(now).color
    for (const id of motion.dots) await blit1($, `dot:${id}`, dotRaster(id, glyphs(options.glyphs === 'ascii' ? 'ascii' : 'emoji').on, dot).cells)
    for (const [id, s] of Object.entries(motion.stamps)) {
      const elapsed = now - s.startedAt
      if (elapsed >= STAMP_MS) continue
      await blit1($, `stamp:${id}`, stampRaster(id, s.kind, elapsed / STAMP_MS).cells)
    }
    if (motion.duckMounted) await blit1($, 'duck', duckLogo(duckPoseAt(now, motion.seed, ANIM_MS)).cells)
  } finally {
    animating = false
  }
}

async function watchTick($: EngineInterface, options: PluginOptions, table: PriceTable): Promise<void> {
  if (watching) return
  watching = true
  try {
    const l = await read($, ledgerAtom)
    const now = Date.now()
    const g = glyphs(options.glyphs === 'ascii' ? 'ascii' : 'emoji')
    const pr = await pricingTick($, options, now)

    if (l.generation !== seenGeneration || l.sessionId !== seenSession) {
      seed(l)
    } else {
      for (const id of l.order) {
        const run = Object.hasOwn(l.runs, id) ? l.runs[id] : undefined
        if (!run) continue
        const before = seenStatus.get(id)
        if (before === run.status) continue
        seenStatus.set(id, run.status)
        if (run.status === 'done' || run.status === 'failed' || run.status === 'killed') {
          const kind = run.status
          await update($, uiAtom, u => {
            const next = Object.entries({ ...(u.stamps ?? {}), [id]: { kind, until: now + STAMP_MS } })
            const kept = next.sort((a, b) => a[1].until - b[1].until).slice(-16)
            return { ...u, stamps: Object.fromEntries(kept) }
          })
          $.clock.after(STAMP_MS, () => void clearStamp($, id))
        }
        if (run.status !== 'running' && (before === undefined || before === 'running') && options.notify === 'on') {
          const shown = shownCost(run, pr.mode, pr.table, pr.fetched)
          $.ui.toast(`${g.duck} ${run.codename} ${statusWords(run.status).spy.toLowerCase()} · ${fmtCost(shown.cost, shown.source, shown.partial === true)}`)
        }
      }
    }

    watchStats($, table, options, l, now)
    watchReports($, table, l, now)

    if (options.motion !== 'off') {
      let ticking = false
      for (const id of l.order) {
        const run = Object.hasOwn(l.runs, id) ? l.runs[id] : undefined
        if (run && run.status === 'running' && trackTotals(run, now, pr)) ticking = true
      }
      if (ticking) startBurst($)
    }

    // any change to the stored record (a status, relay usage or cost arriving late, a replaced verdict) schedules one save
    const history = historySignature(l, pr)
    if (!history.empty && history.signature !== savedSignature) scheduleHistoryWrite($, options)

    const running = l.order.some(id => l.runs[id]?.status === 'running')
    radar.blips = blipsFor(l)
    const ui = await read($, uiAtom)

    const wantsOpen =
      options.autoOpen !== 'off' && !ui.autoOpened && !ui.closedByPerson && l.order.length > 0 && radar.fullscreen
    let placed = false
    if (wantsOpen) {
      // the first run of the session, beside a fullscreen transcript: open once
      await update($, uiAtom, u => ({ ...u, autoOpened: true }))
      try {
        placed = (await $.ui.open({ id: PANE, title: `${g.duck} The Flock`, columns: 52 })).isPlaced
      } catch {
        // the sidebar stays closed; /flock still opens it
      }
    } else if (running || animTimer) {
      placed = await flockPlaced($)
    }

    const stamped = Object.values(ui.stamps ?? {}).some(s => s.until > now)
    const onScreen = radar.mounted !== null || motion.dots.length > 0 || motion.duckMounted || Object.keys(motion.stamps).length > 0
    const wantAnim = options.motion !== 'off' && (running || stamped) && placed && onScreen
    if (wantAnim && !animTimer) animTimer = $.clock.every(ANIM_MS, () => void drawMotion($, options))
    if (!wantAnim && animTimer) {
      animTimer.cancel()
      animTimer = undefined
    }

    // elapsed times in the cards and the band move once a second
    watchCount += 1
    if (running && watchCount % 2 === 0) $.ui.invalidate('ui.render')
  } catch {
    // the next tick tries again
  } finally {
    watching = false
  }
}

export function registerLifecycle(on: On, table: PriceTable, options: PluginOptions): void {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'flock', description: 'Open the watchducks sidebar' })
    } catch {
      // the collectors still work without the command
    }
    try {
      await $.tool.register(ROSTER_SPEC)
    } catch {
      // the model just has no roster tool
    }
    try {
      await $.tool.register(VERDICT_SPEC)
    } catch {
      // the model just has no verdict tool
    }
    try {
      const id = await $.session.id()
      const now = Date.now()
      // same id: a hot reload, keep the ledger and the UI flags; another id: a new session
      let newSession = false
      await update($, ledgerAtom, l => {
        newSession = l.sessionId !== id
        if (!newSession) return l
        const fresh = emptyLedger(id, now)
        return l.sessionId === '' ? fresh : { ...fresh, generation: l.generation + 1 }
      })
      if (newSession) await update($, uiAtom, () => INITIAL_UI)
      await pruneStoredHistory($, now)
      stopTimers()
      savedSignature = undefined // nothing is known to be stored yet: the first watch tick saves once
      agentTimer = $.clock.every(AGENT_POLL_MS, () => void pollAgents($, table))
      saveTimer = $.clock.every(SAVE_MS, () => void saveWhileActive($, options))
      relayTimer = $.clock.every(RELAY_POLL_MS, () => void pollRelays($, table, options))
      seed(await read($, ledgerAtom))
      watchTimer = $.clock.every(WATCH_MS, () => void watchTick($, options, table))
    } catch {
      // the collectors still work without the timers
    }
    await startChild($, options)
    // in the background, after the rest: the start hook never waits for the network
    try {
      $.clock.after(0, () => refreshPrices($, options))
    } catch {
      // the bundled prices
    }
    return next(e)
  })

  // One history write; a /clear then starts an empty ledger under the new session id.
  on('session.end', async ($, e, next) => {
    // the steps below share the end hook's budget (the history write keeps a reserve and is never skipped); a step with no
    // time left is skipped
    const left = (): number => {
      try {
        const ms = next.budget.remainingMs - END_RESERVE_MS
        return Number.isNaN(ms) ? 0 : ms
      } catch {
        return STATS_EXIT_TIMEOUT_MS
      }
    }
    // before anything awaits: which session ends, and when the stats part of the step must be over
    const exit = beginStatsExit(left())
    const turn = timersTurn
    let old: Ledger | undefined
    // runs that ended since the last poll get their final figures, so the report a child writes next and the record hold them
    await finalStats($, table, options, exit)
    // the parent's last look at its children's reports, then the child's own final report (the parent waits for it)
    await finalReports($, table, left())
    await finishChild($, left())
    try {
      old = await read($, ledgerAtom)
      await writeHistory($, old, options)
    } catch {
      // the end step must still run
    }
    // a session that started while this one was ending keeps its timers
    if (e.reason !== 'clear' && turn === timersTurn) stopTimers()
    const result = await next(e)
    if (e.reason === 'clear' && old) {
      try {
        const id = await $.session.id()
        const generation = old.generation + 1
        await update($, ledgerAtom, l => ({ ...emptyLedger(id, Date.now()), generation: Math.max(generation, l.generation + 1) }))
        await update($, uiAtom, () => INITIAL_UI)
        // a native /clear starts a new session id without a session.start: keep the history cap here too
        await pruneStoredHistory($, Date.now())
      } catch {
        // keep the old ledger rather than fail the end step
      }
    }
    return result
  })
}
