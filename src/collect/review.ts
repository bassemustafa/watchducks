import { atom, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { reduce, type Action } from '../ledger'
import type { PriceTable } from '../price'
import { INITIAL_LEDGER } from '../state'

const ledgerAtom = atom({ plugin: 'watchducks', key: 'ledger' } as const, INITIAL_LEDGER)

// Edit counters and ReportFindings counts (spec §6.4). Only the loop id, the
// call id and the result's `count` are read: never an input, never `findings`.

async function send($: EngineInterface, action: Action, table: PriceTable): Promise<void> {
  try {
    await update($, ledgerAtom, l => reduce(l, action, table))
  } catch {
    // a collector failing must not break the hook it observes
  }
}

/** One named field of a tool result; the result is never iterated or stringified. */
function field(result: unknown, key: string): unknown {
  return typeof result === 'object' && result !== null ? (result as Record<string, unknown>)[key] : undefined
}

export function registerReviewCollectors(on: On, table: PriceTable): void {
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const r = await next(e)
    if (!r.deny && !r.isError) await send($, { type: 'editCall', ...(e.agentId ? { loop: e.agentId } : {}), at: Date.now() }, table)
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const r = await next(e)
    if (!r.deny && !r.isError) await send($, { type: 'editCall', ...(e.agentId ? { loop: e.agentId } : {}), at: Date.now() }, table)
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const r = await next(e)
    if (!r.deny && !r.isError) await send($, { type: 'editCall', ...(e.agentId ? { loop: e.agentId } : {}), at: Date.now() }, table)
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'ReportFindings' }, async ($, e, next) => {
    const r = await next(e)
    const count = field(r.result, 'count')
    if (!r.deny && !r.isError && typeof count === 'number') {
      await send(
        $,
        { type: 'findings', ...(e.agentId ? { loop: e.agentId } : {}), toolUseId: e.tool_use_id, count, at: Date.now() },
        table,
      )
    }
    return r
  }).catch(($, e, next) => next(e))
}
