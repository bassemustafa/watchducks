import type { PluginOptions } from 'claude-code'

import type { Ledger } from '../../types'

// Pure helpers for relay result.json polling (spec §6.3). The timer, the file
// system calls and the generation check live in src/lifecycle.ts, which is
// the only file that may hold `$` for them.

export const RELAY_POLL_MS = 3000
/** A relay that never writes its result.json is dropped from the poll this long after it started. */
export const MAX_POLL_AGE_MS = 3 * 60 * 60 * 1000
/** A run that already ended (a foreground relay) is read for this long after it ended. */
export const POLL_GRACE_MS = 120_000

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
 * Ids of the relay runs whose result.json is still worth reading: a running relay
 * with an out-dir for up to 3 h after it started, and one that ended (a foreground
 * relay, or a run closed by a bash result) for 120 s after it ended.
 */
export function duePolls(ledger: Ledger, now: number): string[] {
  const due: string[] = []
  for (const id of ledger.order) {
    const run = Object.hasOwn(ledger.runs, id) ? ledger.runs[id] : undefined
    if (!run || run.kind !== 'relay' || run.outDir === undefined) continue
    if (run.status === 'running') {
      if (now - run.startedAt < MAX_POLL_AGE_MS) due.push(id)
    } else if (run.status !== 'unknown' && run.endedAt !== undefined && now - run.endedAt < POLL_GRACE_MS) {
      due.push(id)
    }
  }
  return due
}
