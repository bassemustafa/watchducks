import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, Timer } from 'claude-code'

import type { HistoryRecord, Ledger } from '../types'
import { HISTORY_PREFIX, pruneHistory, recordFromLedger } from './history'
import { emptyLedger, isKnownLoop, reduce, type Action } from './ledger'
import type { PriceTable } from './price'
import { INITIAL_LEDGER, isHistoryRecord, recordsHeadless } from './state'

const ledgerAtom = atom({ plugin: 'watchducks', key: 'ledger' } as const, INITIAL_LEDGER)

// Session lifecycle (spec §10). A plugin registers `session.start` and
// `session.end` once, and `$` cannot cross an import, so every timer and every
// store write the mod makes lives in this file. Timers sit in module scope: a
// hot reload drops them with the old environment and the next session.start
// starts them again from what `$.state` kept.

const AGENT_POLL_MS = 5000
const SAVE_MS = 60_000

let agentTimer: Timer | undefined
let saveTimer: Timer | undefined
let pollingAgents = false

function stopTimers(): void {
  agentTimer?.cancel()
  saveTimer?.cancel()
  agentTimer = undefined
  saveTimer = undefined
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

async function writeHistory($: EngineInterface, ledger: Ledger, options: PluginOptions): Promise<void> {
  if (ledger.sessionId === '') return
  try {
    if ((await isHeadless($)) && !recordsHeadless(options)) return
    await $.store.set(HISTORY_PREFIX + ledger.sessionId, recordFromLedger(ledger))
  } catch {
    // history is best effort: a failed write must never reach a hook
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

async function saveWhileActive($: EngineInterface, options: PluginOptions): Promise<void> {
  try {
    const l = await read($, ledgerAtom)
    if (!l.order.some(id => l.runs[id]?.status === 'running')) return
    await writeHistory($, l, options)
  } catch {
    // best effort
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
      const id = await $.session.id()
      const now = Date.now()
      // same id: a hot reload, keep the ledger; another id: a new session
      await update($, ledgerAtom, l => {
        if (l.sessionId === id) return l
        const fresh = emptyLedger(id, now)
        return l.sessionId === '' ? fresh : { ...fresh, generation: l.generation + 1 }
      })
      await pruneStoredHistory($, now)
      stopTimers()
      agentTimer = $.clock.every(AGENT_POLL_MS, () => void pollAgents($, table))
      saveTimer = $.clock.every(SAVE_MS, () => void saveWhileActive($, options))
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
      } catch {
        // keep the old ledger rather than fail the end step
      }
    }
    return result
  })
}
