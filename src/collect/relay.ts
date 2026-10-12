import type { PluginOptions } from 'claude-code'

import type { Ledger, Run } from '../../types'
import { fnv1a } from '../codename'
import type { RelayIdentity } from '../relay-result'

// Pure helpers for relay result.json polling (spec §6.3). The timer, the file
// system calls and the generation check live in src/lifecycle.ts, which is
// the only file that may hold `$` for them.

export const RELAY_POLL_MS = 3000
/** A relay that never writes its result.json is dropped from the poll this long after it started. */
export const MAX_POLL_AGE_MS = 3 * 60 * 60 * 1000
/** A run that already ended (a foreground relay) is read for this long after it ended. */
export const POLL_GRACE_MS = 120_000

/** One discovery pass runs on every third relay poll (about 9 s). */
export const DISCOVERY_EVERY = 3
/** Slack before the oldest pending run's start: a result.json or directory older than that is not its. */
export const DISCOVERY_SLACK_MS = 5000
/** A result.json may report a start up to this long after the run's recorded start. */
export const MATCH_AHEAD_MS = 60_000
/** Per pass: `$.fs.stat` calls, result.json reads, and entries considered in one listed directory. */
export const MAX_DISCOVERY_STATS = 512
export const MAX_DISCOVERY_READS = 32
export const MAX_LISTED_ENTRIES = 2048
/** Result files remembered as too old to be a pending run's. */
export const MAX_SKIPPED = 1024
/** Result files whose identity is remembered while their mtime and size stay the same. */
export const MAX_IDENTITIES = 1024
/** A discovery pass walks at most this many roots, and stops walking after this long. */
export const MAX_DISCOVERY_ROOTS = 16
export const DISCOVERY_BUDGET_MS = 2000
/** A pass matches at most the newest pending runs against at most the first found results. */
export const MAX_MATCH_RUNS = 64
export const MAX_MATCH_FOUND = 1024

/**
 * An opaque key for a path (two FNV-1a hashes): discovery remembers what it saw about a file or a root under
 * this, never under the path, so nothing it passed over keeps a name in memory.
 */
export function fingerprint(text: string): string {
  return fnv1a(text).toString(36) + '-' + fnv1a(text + '\u0000').toString(36)
}

const versionKey = (file: string, mtimeMs: number, size: number): string => fingerprint(`${file}\u0000${mtimeMs}\u0000${size}`)

/**
 * What discovery learned in earlier passes, kept only under fingerprints: an identity by the fingerprint of the
 * file's path (valid while its mtime and size stay the same), a skip by the fingerprint of path + mtime + size
 * (a rewrite is looked at again), a cursor by the fingerprint of the root. No path and no text is stored.
 */
export class DiscoveryMemory {
  private readonly identities = new Map<string, { mtimeMs: number; size: number; identity: RelayIdentity | null }>()
  private readonly skipped = new Set<string>()
  private readonly cursors = new Map<string, number>()

  /** undefined: not cached, or the file changed since. */
  identity(file: string, mtimeMs: number, size: number): RelayIdentity | null | undefined {
    const cached = this.identities.get(fingerprint(file))
    return cached && cached.mtimeMs === mtimeMs && cached.size === size ? cached.identity : undefined
  }

  rememberIdentity(file: string, mtimeMs: number, size: number, identity: RelayIdentity | null): void {
    const key = fingerprint(file)
    this.identities.delete(key)
    if (this.identities.size >= MAX_IDENTITIES) {
      const oldest = this.identities.keys().next()
      if (!oldest.done) this.identities.delete(oldest.value)
    }
    this.identities.set(key, { mtimeMs, size, identity })
  }

  isSkipped(file: string, mtimeMs: number, size: number): boolean {
    return this.skipped.has(versionKey(file, mtimeMs, size))
  }

  skip(file: string, mtimeMs: number, size: number): void {
    if (this.skipped.size >= MAX_SKIPPED) {
      const oldest = this.skipped.values().next()
      if (!oldest.done) this.skipped.delete(oldest.value)
    }
    this.skipped.add(versionKey(file, mtimeMs, size))
  }

  cursor(root: string): number {
    return this.cursors.get(fingerprint(root)) ?? 0
  }

  setCursor(root: string, at: number): void {
    this.cursors.set(fingerprint(root), at)
  }

  clear(): void {
    this.identities.clear()
    this.skipped.clear()
    this.cursors.clear()
  }

  /** Every key held, for tests. */
  keys(): string[] {
    return [...this.identities.keys(), ...this.skipped, ...this.cursors.keys()]
  }
}

/**
 * The directories where a relay `--out-dir` may live: the temp dir, `/tmp`, the
 * session root, then the `relayRoots` option split on ':'. Empty entries are dropped.
 */
export function relayRoots(options: PluginOptions, tmpDir: string, sessionRoot: string): string[] {
  const extra = typeof options.relayRoots === 'string' ? options.relayRoots.split(':') : []
  const roots: string[] = []
  for (const root of [tmpDir, '/tmp', sessionRoot, ...extra]) {
    if (root !== '' && !roots.includes(root)) roots.push(root)
  }
  return roots
}

/** The resolved roots a result.json may sit under: an empty one or the file system root would allow everything. */
export function allowedRoots(resolved: readonly string[]): string[] {
  return resolved.filter(root => root !== '' && root !== '/')
}

/** `<out-dir>/result.json` */
export function resultPath(outDir: string): string {
  return (outDir.endsWith('/') ? outDir.slice(0, -1) : outDir) + '/result.json'
}

/**
 * Ids of the relay runs whose result.json is still worth reading (not yet applied): a running relay
 * with an out-dir for up to 3 h after it started, and one that ended (a foreground
 * relay, or a run closed by a bash result) for 120 s after it ended.
 */
export function duePolls(ledger: Ledger, now: number): string[] {
  const due: string[] = []
  for (const id of ledger.order) {
    const run = Object.hasOwn(ledger.runs, id) ? ledger.runs[id] : undefined
    if (!run || run.kind !== 'relay' || run.outDir === undefined || run.resultRead) continue
    if (run.status === 'running') {
      if (now - run.startedAt < MAX_POLL_AGE_MS) due.push(id)
    } else if (run.status !== 'unknown' && run.endedAt !== undefined && now - run.endedAt < POLL_GRACE_MS) {
      due.push(id)
    }
  }
  return due
}

/**
 * Relay runs with no out-dir whose result.json discovery still looks for: running for under 3 h, or
 * ended less than 120 s ago, and not yet read. Creation order.
 */
export function pendingDiscovery(ledger: Ledger, now: number): Run[] {
  const pending: Run[] = []
  for (const id of ledger.order) {
    const run = Object.hasOwn(ledger.runs, id) ? ledger.runs[id] : undefined
    if (!run || run.kind !== 'relay' || run.outDir !== undefined || run.resultRead) continue
    if (run.status === 'running') {
      if (now - run.startedAt < MAX_POLL_AGE_MS) pending.push(run)
    } else if (run.status !== 'unknown' && run.endedAt !== undefined && now - run.endedAt < POLL_GRACE_MS) {
      pending.push(run)
    }
  }
  return pending
}

const KNOWN_TOOLS: ReadonlySet<string> = new Set(['opencode', 'claude', 'codex', 'gemini'])

/** A result.json found by discovery: its directory and what it says about itself (the working directory only as a hash). */
export type FoundResult = { dir: string; startedAt: number; tool?: string; workdirKey?: string }

/**
 * Pairs pending runs with the directories found for them. A pair needs a start within
 * `[run.startedAt - 5 s, run.startedAt + 60 s]`, a result that names its tool (the run's implementer when that
 * is known, any tool when it is `unknown`), the same working directory when the run has one (the result must
 * name it too), and an unclaimed directory. Absence never agrees. Closest starts are paired first; each run and
 * each directory is used once. Only the 64 newest pending runs and the first 1024 results are considered.
 */
export function matchDiscovered(
  pending: readonly Run[],
  found: readonly FoundResult[],
  claimed: ReadonlySet<string>,
): Array<{ id: string; outDir: string }> {
  const pairs: Array<{ run: number; dir: number; gap: number }> = []
  const runs = pending.slice(-MAX_MATCH_RUNS)
  const results = found.slice(0, MAX_MATCH_FOUND)
  runs.forEach((run, r) => {
    results.forEach((f, d) => {
      if (claimed.has(f.dir)) return
      const ahead = f.startedAt - run.startedAt
      if (ahead < -DISCOVERY_SLACK_MS || ahead > MATCH_AHEAD_MS) return
      if (f.tool === undefined || !KNOWN_TOOLS.has(f.tool) || (run.implementer !== 'unknown' && f.tool !== run.implementer)) return
      if (run.workdirKey !== undefined && f.workdirKey !== run.workdirKey) return
      pairs.push({ run: r, dir: d, gap: Math.abs(ahead) })
    })
  })
  pairs.sort((x, y) => x.gap - y.gap || x.run - y.run || x.dir - y.dir)
  const usedRuns = new Set<number>()
  const usedDirs = new Set<string>()
  const matches: Array<{ id: string; outDir: string }> = []
  for (const { run, dir } of pairs) {
    const id = runs[run]!.id
    const outDir = results[dir]!.dir
    if (usedRuns.has(run) || usedDirs.has(outDir)) continue
    usedRuns.add(run)
    usedDirs.add(outDir)
    matches.push({ id, outDir })
  }
  return matches
}
