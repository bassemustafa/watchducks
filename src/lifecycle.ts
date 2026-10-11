import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsStat, On, PluginOptions, Timer } from 'claude-code'

import type { HistoryRecord, Ledger, RelayProjection, Run } from '../types'
import {
  DISCOVERY_EVERY,
  MATCH_AHEAD_MS,
  MAX_DISCOVERY_READS,
  MAX_DISCOVERY_STATS,
  MAX_IDENTITIES,
  MAX_LISTED_ENTRIES,
  MAX_SKIPPED,
  RELAY_POLL_MS,
  allowedRoots,
  duePolls,
  matchDiscovered,
  pendingDiscovery,
  relayRoots,
  resultPath,
  type FoundResult,
} from './collect/relay'
import { HISTORY_PREFIX, pruneHistory, recordFromLedger } from './history'
import { emptyLedger, isKnownLoop, reduce, type Action } from './ledger'
import type { PriceTable } from './price'
import { MAX_RESULT_BYTES, isInsideRoots, projectRelayResult, relayIdentity, type RelayIdentity } from './relay-result'
import { INITIAL_LEDGER, INITIAL_UI, isHistoryRecord, recordsHeadless } from './state'
import { ROSTER_SPEC, VERDICT_SPEC } from './tools'
import { blipsFor, radar } from './ui/animate'
import { fmtCost } from './ui/format'
import { radarFrame } from './ui/raster'
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
let pollingAgents = false
let pollingRelays = false

function stopTimers(): void {
  discoveryPolls = 0
  discoveryGeneration = -1 // the next pass starts with no claimed or skipped directory
  identityCache.clear()
  agentTimer?.cancel()
  saveTimer?.cancel()
  relayTimer?.cancel()
  watchTimer?.cancel()
  animTimer?.cancel()
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

/** The relay roots, each resolved to where it really lands (a root that cannot be resolved is skipped), and where the session root landed. */
async function resolvedRoots($: EngineInterface, options: PluginOptions): Promise<{ roots: string[]; session: string }> {
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
  for (const root of relayRoots(options, tmpDir, sessionRoot)) {
    try {
      const stat = await $.fs.stat(root, { resolve: true })
      if (stat.realPath === undefined) continue
      resolved.push(stat.realPath)
      if (sessionRoot !== '' && root === sessionRoot) session = stat.realPath
    } catch {
      // a root that is not there allows nothing
    }
  }
  return { roots: allowedRoots(resolved), session }
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

// Discovery state (a relay run with no --out-dir): the polls since a run became pending, the directories
// already given to a run, and result files known to be older than every pending run. The sets are dropped
// when the ledger generation changes, and all of it with a hot reload.
let discoveryPolls = 0
let discoveryGeneration = -1
let claimedDirs = new Set<string>()
const skippedResults = new Set<string>()
// What a result.json identified as when it was last read, keyed by file and valid while its mtime and size
// stay the same: a fresh file that matches no pending run is then read once, not on every pass. Never any text.
const identityCache = new Map<string, { mtimeMs: number; size: number; identity: RelayIdentity | null }>()

function rememberIdentity(file: string, entry: { mtimeMs: number; size: number; identity: RelayIdentity | null }): void {
  identityCache.delete(file)
  if (identityCache.size >= MAX_IDENTITIES) {
    const oldest = identityCache.keys().next()
    if (!oldest.done) identityCache.delete(oldest.value)
  }
  identityCache.set(file, entry)
}

function rememberSkipped(file: string): void {
  if (skippedResults.size >= MAX_SKIPPED) {
    const oldest = skippedResults.values().next()
    if (!oldest.done) skippedResults.delete(oldest.value)
  }
  skippedResults.add(file)
}

function trimSlash(dir: string): string {
  return dir.length > 1 && dir.endsWith('/') ? dir.slice(0, -1) : dir
}

/**
 * One pass over the allowed roots for the result.json of relay runs that have no out-dir. Directory names
 * are read only to walk; a candidate is identified by what its result.json says (start, tool, a hash of the
 * working directory), never by its name. Only the matched directory is stored, as the run's out-dir.
 */
async function discoverRelays(
  $: EngineInterface,
  seen: Ledger,
  pending: readonly Run[],
  roots: readonly string[],
  session: string,
  table: PriceTable,
): Promise<void> {
  if (seen.generation !== discoveryGeneration) {
    discoveryGeneration = seen.generation
    claimedDirs = new Set()
    skippedResults.clear()
    identityCache.clear()
  }
  const t0 = Math.min(...pending.map(r => r.startedAt)) - STALE_SLACK_MS
  let stats = 0
  let reads = 0
  const exhausted = (): boolean => stats >= MAX_DISCOVERY_STATS

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
    if (skippedResults.has(file)) return
    const stat = await statOf(file, true)
    const realPath = stat === null ? null : readablePath(stat, t0, roots, false)
    if (stat === null || realPath === null) return
    try {
      // an unchanged file keeps its identity: it is not read again and does not use up the pass's reads
      const cached = identityCache.get(file)
      let identity: RelayIdentity | null
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        identity = cached.identity
      } else {
        if (reads >= MAX_DISCOVERY_READS) return
        reads += 1
        // the text lives only for this identification: a start, a tool and a hash leave it
        identity = relayIdentity(await $.fs.read(realPath))
        rememberIdentity(file, { mtimeMs: stat.mtimeMs, size: stat.size, identity })
      }
      if (!identity) return
      if (identity.startedAt < t0 - MATCH_AHEAD_MS) {
        rememberSkipped(file)
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

  for (const root of new Set(roots)) {
    const shallow = root === session
    for (const name of await childDirs(root)) {
      if (exhausted()) break
      const dir = trimSlash(root) + '/' + name
      const fresh = await visit(dir)
      if (!fresh || shallow) continue
      for (const inner of await childDirs(dir)) {
        if (exhausted()) break
        await visit(dir + '/' + inner)
      }
    }
  }

  const taken = new Set(claimedDirs)
  for (const run of Object.values(seen.runs)) if (run.outDir !== undefined) taken.add(trimSlash(run.outDir))
  for (const { id, outDir } of matchDiscovered(pending, found, taken)) {
    // a /clear or a session change while the pass was running: the match belongs to the old ledger
    let applied = false
    await update($, ledgerAtom, l => {
      applied = l.generation === seen.generation
      return applied ? reduce(l, { type: 'relayFound', id, outDir, at: Date.now() }, table) : l
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
    const { roots, session } = await resolvedRoots($, options)
    // the pass only sets an out-dir; the loop below reads the result on the next tick, the one way a result is applied
    if (pending.length > 0 && discoveryPolls % DISCOVERY_EVERY === 0) {
      try {
        await discoverRelays($, seen, pending, roots, session, table)
      } catch {
        // the next pass tries again
      }
    }
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
  } catch {
    // the next tick tries again
  } finally {
    pollingRelays = false
  }
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
// of the session, and starts or stops the 200 ms radar timer. Module state
// dies with a hot reload; session.start seeds it again from the ledger so no
// old run is stamped or toasted twice.

const WATCH_MS = 500
const ANIM_MS = 200
const STAMP_MS = 1500
const HISTORY_DELAY_MS = 2000
const PANE = 'flock'

let watching = false
let animating = false
let watchCount = 0
let seenGeneration = -1
let seenSession = ''
const seenStatus = new Map<string, string>()
let historyPending = false
// history saves run one at a time; a change that arrives while one is in flight is saved right after it
let saving = false
let dirtyAgain = false
// what the last successful save stored; a hot reload drops it, so the first watch tick saves once
let savedSignature: string | undefined

function seed(l: Ledger): void {
  seenGeneration = l.generation
  seenSession = l.sessionId
  seenStatus.clear()
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
      if (u.stamp?.runId !== runId) return u
      const { stamp: _stamp, ...rest } = u
      return rest
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

async function drawRadar($: EngineInterface): Promise<void> {
  if (animating) return
  animating = true
  try {
    const m = radar.mounted
    if (!m) return
    radar.tick = (radar.tick + 1) % 48
    await $.ui.blit({ requestId: PANE, key: 'radar', cells: radarFrame(radar.tick, radar.blips, m.columns, m.rows).cells })
  } catch {
    // a missed frame is not an error
  } finally {
    animating = false
  }
}

async function watchTick($: EngineInterface, options: PluginOptions): Promise<void> {
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
        if (run.status === 'done') {
          await update($, uiAtom, u => ({ ...u, stamp: { runId: id, until: now + STAMP_MS } }))
          $.clock.after(STAMP_MS, () => void clearStamp($, id))
        }
        if (run.status !== 'running' && (before === undefined || before === 'running') && options.notify === 'on') {
          $.ui.toast(`${g.duck} ${run.codename} ${statusWords(run.status).spy.toLowerCase()} · ${fmtCost(run.cost, run.costSource, run.costPartial)}`)
        }
      }
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

    const wantAnim = options.motion !== 'off' && running && placed && radar.mounted !== null
    if (wantAnim && !animTimer) animTimer = $.clock.every(ANIM_MS, () => void drawRadar($))
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
      watchTimer = $.clock.every(WATCH_MS, () => void watchTick($, options))
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
