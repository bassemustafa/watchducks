import { atom, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { reduce, type Action, type StepUsage } from '../ledger'
import type { PriceTable } from '../price'
import { INITIAL_LEDGER } from '../state'

const ledgerAtom = atom({ plugin: 'watchducks', key: 'ledger' } as const, INITIAL_LEDGER)

// Subagent collectors (spec §6.1): engine events in, ledger actions out. Only
// ids, numbers and enums are read; chunks, prompts, answers and descriptions
// are never touched, and a failed dispatch never reaches the hook's caller.

type ApiUsage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

function stepUsage(u: ApiUsage | null | undefined): StepUsage | null {
  if (!u) return null
  return {
    model: u.model,
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens,
  }
}

/** Ids of a classic `background_tasks` field; undefined when the field is not an array (no observation). */
function taskIds(tasks: unknown): string[] | undefined {
  if (!Array.isArray(tasks)) return undefined
  const ids: string[] = []
  for (const task of tasks as unknown[]) {
    const id = typeof task === 'object' && task !== null ? (task as { id?: unknown }).id : undefined
    if (typeof id === 'string') ids.push(id)
  }
  return ids
}

async function send($: EngineInterface, action: Action, table: PriceTable): Promise<void> {
  try {
    await update($, ledgerAtom, l => reduce(l, action, table))
  } catch {
    // a collector failing must not break the hook it observes
  }
}

export function registerAgentCollectors(on: On, table: PriceTable): void {
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && r.agentId) {
      const requestedModel = r.model || e.model
      await send(
        $,
        {
          type: 'spawn',
          id: r.agentId,
          agentType: e.subagentType,
          ...(requestedModel ? { requestedModel } : {}),
          ...(e.parentAgentId ? { parentId: e.parentAgentId } : {}),
          at: Date.now(),
        },
        table,
      )
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    await send(
      $,
      {
        type: 'step',
        ...(e.agentId ? { loop: e.agentId } : {}),
        turnId: e.turnId,
        index: e.index,
        model: e.model,
        ...(e.effort !== undefined ? { effort: e.effort } : {}),
        usage: stepUsage(result.usage),
        at: Date.now(),
      },
      table,
    )
    return result
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const usage = stepUsage(e.usage)
    await send(
      $,
      {
        type: 'turnComplete',
        ...(e.agentId ? { loop: e.agentId } : {}),
        turnId: e.turnId,
        reason: e.reason,
        ...(usage ? { usage } : {}),
        at: Date.now(),
      },
      table,
    )
    return r
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    const ids = taskIds(e.background_tasks)
    if (ids) await send($, { type: 'bgSnapshot', taskIds: ids, at: Date.now() }, table)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const ids = taskIds(e.background_tasks)
    if (ids) await send($, { type: 'bgSnapshot', taskIds: ids, at: Date.now() }, table)
    return next(e)
  }).catch(($, e, next) => next(e))
}
