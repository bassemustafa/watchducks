import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { isKnownLoop, reduce, type Action, type StepUsage } from '../ledger'
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

/** Loop ids `$.agent.list()` was already asked about; a hot reload empties it. */
const LOOKED_UP_MAX = 1024
const lookedUp = new Set<string>()
// the ledger generation `lookedUp` belongs to: a /clear or a new session drops the runs it adopted
let lookedUpGeneration = -1

/**
 * A loop the ledger does not know (never seen at `agent.spawn`, e.g. a forked skill) is looked up once
 * in `$.agent.list()`; when listed it becomes an agent run before its first step is charged.
 * Only the id, type and parent are read: never the description.
 */
async function adoptIfListed($: EngineInterface, loop: string, table: PriceTable): Promise<void> {
  try {
    const ledger = await read($, ledgerAtom)
    if (ledger.generation !== lookedUpGeneration) {
      lookedUp.clear()
      lookedUpGeneration = ledger.generation
    }
    if (lookedUp.has(loop)) return
    if (isKnownLoop(ledger, loop)) return
    lookedUp.add(loop)
    if (lookedUp.size > LOOKED_UP_MAX) {
      const oldest = lookedUp.values().next()
      if (!oldest.done) lookedUp.delete(oldest.value)
    }
    let listed: Awaited<ReturnType<EngineInterface['agent']['list']>>
    try {
      listed = await $.agent.list()
    } catch {
      lookedUp.delete(loop)
      return
    }
    const info = listed.find(a => a.id === loop)
    if (!info) return
    await send(
      $,
      { type: 'adopt', id: loop, agentType: info.type, ...(info.parentId ? { parentId: info.parentId } : {}), at: Date.now() },
      table,
    )
  } catch {
    // an unlisted or unreadable loop stays engine overhead
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
    if (e.agentId) {
      await adoptIfListed($, e.agentId, table)
      // a resumed agent runs again as its request starts, not when the stream ends (metadata only, no usage)
      await send(
        $,
        {
          type: 'step',
          loop: e.agentId,
          turnId: e.turnId,
          index: e.index,
          model: e.model,
          ...(e.effort !== undefined ? { effort: e.effort } : {}),
          usage: null,
          at: Date.now(),
        },
        table,
      )
    }
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
