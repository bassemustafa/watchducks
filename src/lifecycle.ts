import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsStat, On, PluginOptions, Timer } from 'claude-code'

import type { HistoryRecord, Ledger, RelayProjection, Run } from '../types'
import { STATS_ARGV, STATS_EVERY_MS, STATS_TIMEOUT_MS, attribute, projectStats, type StatsSnapshot } from './adapters/opencode-stats'
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
import { emptyLedger, isKnownLoop, normalizeDir, reduce, type Action } from './ledger'
import type { PriceTable } from './price'
import { fnv1a } from './codename'
import { MAX_RESULT_BYTES, isInsideRoots, projectRelayResult, relayIdentity } from './relay-result'
import { INITIAL_LEDGER, INITIAL_UI, isHistoryRecord, recordsHeadless } from './state'
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

function stopTimers(): void {
  discoveryPolls = 0
  discoveryGeneration = -1 // the next pass starts with nothing remembered
  resetDiscovery()
  statsTimer?.cancel()
  statsTimer = undefined
  statsBusy = false
  resetStats()
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
async function writeHistory($: EngineInterface, ledger: Ledger, options: PluginOptions): Promise<boolean> {
  if (ledger.sessionId === '') return true
  try {
    if ((await isHeadless($)) && !recordsHeadless(options)) return true
    await $.store.set(HISTORY_PREFIX + ledger.sessionId, recordFromLedger(ledger))
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

/**
 * The relay roots, each resolved to where it really lands (a root that cannot be resolved is skipped), where the
 * session root landed, and how many `$.fs.stat` calls the resolving took (discovery counts them in its budget).
 */
async function resolvedRoots($: EngineInterface, options: PluginOptions): Promise<{ roots: string[]; session: string; stats: number }> {
  let tmpDir = '/tmp'
  try {
    const dir = await $.env.get('TMPDIR')
    if (dir !== undefined && dir !== '') tmpDir = dir
  } catch {
    // the fixed /tmp root still applies
  }
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

// opencode stats (spec §3). While `opencodeStats` is on and an opencode run is running (or ended less than the relay
// grace ago), one timer takes `opencode stats` snapshots per working directory and gives each run its share. The
// process runs one at a time for the session, at most once per STATS_EVERY_MS per directory; its stdout is projected to
// numbers by `projectStats` and its stderr is never read. What is kept here is numbers and run ids: the working
// directory is read from the run for the call and not kept.

const STATS_SLACK_MS = 50 // a timer tick may land a hair before the interval is over
const STATS_MAX_FAILURES = 3

let statsTimer: Timer | undefined
let statsBusy = false
let statsFailures = 0
let statsGeneration = -1
// the snapshot each run was first seen at
const statsBase = new Map<string, StatsSnapshot>()
// runs whose final snapshot has been applied
const statsFinal = new Set<string>()
// when the process last started for a working directory key
const statsAttempt = new Map<string, number>()
// the figures last sent for a run, so an unchanged run writes nothing
const statsSent = new Map<string, string>()

function resetStats(): void {
  statsFailures = 0
  statsGeneration = -1
  statsBase.clear()
  statsFinal.clear()
  statsAttempt.clear()
  statsSent.clear()
}

function syncStatsGeneration(l: Ledger): void {
  if (l.generation === statsGeneration) return
  resetStats()
  statsGeneration = l.generation
}

const dirOf = (run: Run): string => run.workdirKey ?? 'session'
const shortModel = (model: string | undefined): string => (model === undefined ? '' : model.slice(model.lastIndexOf('/') + 1))

function isStatsRun(run: Run): boolean {
  if (run.implementer !== 'opencode' || (run.kind !== 'cli' && run.kind !== 'relay')) return false
  // an exact relay result wins over stats: no process is needed for it
  return !(run.usageSource === 'relay' && run.costSource === 'reported')
}

/** Opencode runs that need a snapshot: running, or ended less than the grace ago and not yet given their final one. */
function statsLive(l: Ledger, now: number): Run[] {
  const live: Run[] = []
  for (const id of l.order) {
    const run = Object.hasOwn(l.runs, id) ? l.runs[id] : undefined
    if (!run || !isStatsRun(run)) continue
    if (run.status === 'running') live.push(run)
    else if (run.endedAt !== undefined && now - run.endedAt < POLL_GRACE_MS && !statsFinal.has(run.id)) live.push(run)
  }
  return live
}

/** Runs of one model whose running intervals overlap (chained) form one group; a lone run is a group of one. */
function statsGroups(members: readonly Run[], now: number): Run[][] {
  const byModel = new Map<string, Run[]>()
  for (const run of members) {
    const key = shortModel(run.model)
    byModel.set(key, [...(byModel.get(key) ?? []), run])
  }
  const groups: Run[][] = []
  for (const runs of byModel.values()) {
    let current: Run[] = []
    let reach = 0
    for (const run of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
      if (current.length > 0 && run.startedAt <= reach) {
        current.push(run)
        reach = Math.max(reach, run.endedAt ?? now)
      } else {
        if (current.length > 0) groups.push(current)
        current = [run]
        reach = run.endedAt ?? now
      }
    }
    if (current.length > 0) groups.push(current)
  }
  return groups
}

async function takeStats($: EngineInterface, cwd: string | undefined): Promise<StatsSnapshot | null> {
  try {
    const r = await $.process.run(STATS_ARGV, { ...(cwd !== undefined ? { cwd } : {}), timeoutMs: STATS_TIMEOUT_MS })
    if (r.exitCode !== 0 || r.isStdoutTruncated) return null
    return projectStats(r.stdout, Date.now())
  } catch {
    return null
  }
}

/** Gives every run of one working directory its share of the snapshot, in one atomic ledger update. */
async function applyStats($: EngineInterface, table: PriceTable, seen: Ledger, dir: string, live: readonly Run[], snap: StatsSnapshot): Promise<void> {
  const now = Date.now()
  for (const run of live) if (!statsBase.has(run.id)) statsBase.set(run.id, snap)
  const liveIds = new Set(live.map(r => r.id))
  // every run of the directory this adapter has followed, so a group keeps its members after one of them leaves
  const tracked: Run[] = []
  for (const id of seen.order) {
    const run = Object.hasOwn(seen.runs, id) ? seen.runs[id] : undefined
    if (run && isStatsRun(run) && dirOf(run) === dir && statsBase.has(id)) tracked.push(run)
  }

  const actions: Action[] = []
  const signatures = new Map<string, string>()
  for (const group of statsGroups(tracked, now)) {
    if (!group.some(r => liveIds.has(r.id))) continue
    const base = group.map(r => statsBase.get(r.id)!).reduce((a, b) => (b.at < a.at ? b : a))
    if (base === snap) continue // baselined just now: nothing to count yet
    const share = attribute(base, snap, group[0]!.model)
    const overlapping = tracked.filter(r => r.startedAt <= snap.at && (r.endedAt ?? now) >= base.at).length
    const approx = share.approx || snap.sessions - base.sessions > overlapping
    // the earliest start names the group: a run joining it cannot move that, and a later group of the same folder and model gets its own key
    const sharedKey =
      group.length > 1 ? fingerprint(`${dir}|${shortModel(group[0]!.model)}|${Math.min(...group.map(r => r.startedAt))}`) : undefined
    for (const run of group) {
      const u = share.usage
      const signature = `${u.uncached}|${u.output}|${u.cacheRead}|${u.cacheWrite}|${share.cost}|${approx}|${sharedKey ?? ''}|${group.length}`
      if (statsSent.get(run.id) === signature) continue
      signatures.set(run.id, signature)
      actions.push({
        type: 'adapterUsage',
        id: run.id,
        source: 'stats',
        usage: u,
        cost: share.cost,
        costSource: 'reported',
        ...(approx ? { approx: true } : {}),
        ...(sharedKey !== undefined ? { sharedKey, sharedSize: group.length } : {}),
        at: now,
      })
    }
  }

  let applied = false
  await update($, ledgerAtom, l => {
    applied = l.generation === seen.generation
    return applied ? actions.reduce((acc, a) => reduce(acc, a, table), l) : l
  })
  if (!applied) return
  for (const [id, signature] of signatures) statsSent.set(id, signature)
  for (const run of live) if (run.status !== 'running') statsFinal.add(run.id)
}

async function statsTick($: EngineInterface, table: PriceTable, options: PluginOptions): Promise<void> {
  if (statsBusy || options.opencodeStats !== 'on') return
  statsBusy = true
  try {
    const seen = await read($, ledgerAtom)
    syncStatsGeneration(seen)
    if (statsFailures >= STATS_MAX_FAILURES) return
    const byDir = new Map<string, Run[]>()
    for (const run of statsLive(seen, Date.now())) byDir.set(dirOf(run), [...(byDir.get(dirOf(run)) ?? []), run])
    for (const [dir, live] of byDir) {
      // the engine's clock paces the snapshots; run times are wall-clock like the rest of the ledger
      const tickAt = await $.clock.now()
      const last = statsAttempt.get(dir)
      if (last !== undefined && tickAt - last < STATS_EVERY_MS - STATS_SLACK_MS) continue
      let cwd = live.find(r => r.workdir !== undefined)?.workdir
      if (cwd === undefined) {
        try {
          cwd = await $.session.root()
        } catch {
          // the process then starts in the session's own directory
        }
      }
      statsAttempt.set(dir, tickAt)
      const snap = await takeStats($, cwd)
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
      if ((await read($, ledgerAtom)).generation !== seen.generation) return
      await applyStats($, table, seen, dir, live, snap)
    }
  } catch {
    // the next tick tries again
  } finally {
    statsBusy = false
  }
}

/** Called by the watch tick: the stats timer exists while the setting is on and an opencode run needs a snapshot; a run not seen yet is looked at at once. */
function watchStats($: EngineInterface, table: PriceTable, options: PluginOptions, l: Ledger, now: number): void {
  syncStatsGeneration(l)
  const live = options.opencodeStats === 'on' && statsFailures < STATS_MAX_FAILURES ? statsLive(l, now) : []
  if (live.length === 0) {
    statsTimer?.cancel()
    statsTimer = undefined
    return
  }
  if (!statsTimer) statsTimer = $.clock.every(STATS_EVERY_MS, () => void statsTick($, table, options))
  if (live.some(r => !statsBase.has(r.id))) void statsTick($, table, options)
}

async function saveWhileActive($: EngineInterface, options: PluginOptions): Promise<void> {
  try {
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
function trackTotals(run: Run, now: number): boolean {
  const tokens = run.usage ? run.usage.uncached + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite : 0
  const prev = seenTotals.get(run.id)
  seenTotals.set(run.id, { tokens, cost: run.cost })
  if (!prev || (prev.tokens === tokens && prev.cost === run.cost)) return false
  const shown = Object.hasOwn(motion.tickers, run.id) ? tickerValue(motion.tickers[run.id]!, now) : { tokens: prev.tokens, cost: prev.cost ?? 0 }
  motion.tickers[run.id] = { fromTokens: shown.tokens, toTokens: tokens, fromCost: shown.cost, toCost: run.cost ?? shown.cost, startedAt: now }
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
function historySignature(l: Ledger): { signature: string; empty: boolean } {
  const days = JSON.stringify(recordFromLedger(l).days)
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
    const { signature } = historySignature(ledger)
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
          $.ui.toast(`${g.duck} ${run.codename} ${statusWords(run.status).spy.toLowerCase()} · ${fmtCost(run.cost, run.costSource, run.costPartial)}`)
        }
      }
    }

    watchStats($, table, options, l, now)

    if (options.motion !== 'off') {
      let ticking = false
      for (const id of l.order) {
        const run = Object.hasOwn(l.runs, id) ? l.runs[id] : undefined
        if (run && run.status === 'running' && trackTotals(run, now)) ticking = true
      }
      if (ticking) startBurst($)
    }

    // any change to the stored record (a status, relay usage or cost arriving late, a replaced verdict) schedules one save
    const history = historySignature(l)
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
    return next(e)
  })

  // One history write; a /clear then starts an empty ledger under the new session id.
  on('session.end', async ($, e, next) => {
    let old: Ledger | undefined
    try {
      old = await read($, ledgerAtom)
      await writeHistory($, old, options)
    } catch {
      // the end step must still run
    }
    if (e.reason !== 'clear') stopTimers()
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
