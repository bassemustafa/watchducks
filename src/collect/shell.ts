import { atom, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { classify } from '../classify'
import { reduce, type Action } from '../ledger'
import type { PriceTable } from '../price'
import { INITIAL_LEDGER } from '../state'

const ledgerAtom = atom({ plugin: 'watchducks', key: 'ledger' } as const, INITIAL_LEDGER)

// Bash collector (spec §6.2): the command goes to the classifier and nowhere
// else; stdout and stderr are never read. A relay's result.json is polled from
// state by the timer in src/lifecycle.ts, so nothing starts here but the run.

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

export function registerShellCollector(on: On, table: PriceTable): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cls = classify(typeof e.command === 'string' ? e.command : '')
    const id = 'bash:' + e.tool_use_id
    const track = cls.kind !== 'shell' || e.run_in_background === true
    if (track) await send($, { type: 'bashStart', id, cls, at: Date.now() }, table)

    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(e)
    } catch (error) {
      // aborted beneath us: end a tracked run as killed; the error is rethrown untouched
      if (track) await send($, { type: 'bashResult', id, isError: true, interrupted: true, at: Date.now() }, table)
      throw error
    }

    const taskId = field(r.result, 'backgroundTaskId')
    const backgroundTaskId = typeof taskId === 'string' && taskId !== '' ? taskId : undefined
    if (track || backgroundTaskId) {
      if (!track) await send($, { type: 'bashStart', id, cls, at: Date.now() }, table)
      await send(
        $,
        {
          type: 'bashResult',
          id,
          isError: r.isError === true || r.deny !== undefined,
          interrupted: field(r.result, 'interrupted') === true,
          ...(backgroundTaskId ? { backgroundTaskId } : {}),
          at: Date.now(),
        },
        table,
      )
    }
    return r
  }).catch(($, e, next) => next(e))
}
