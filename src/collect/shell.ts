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
// A background task's notification row (UserMessage) gives its real outcome:
// only its status and ids are read, never its text; the row is passed on untouched.

// rows redraw often (scroll, resize): an outcome already sent is not sent again
const sentOutcomes = new Set<string>()

const OUTCOMES: Readonly<Record<string, 'done' | 'failed' | 'killed'>> = { completed: 'done', failed: 'failed', killed: 'killed' }

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

/** HOME, read only when the classified command names a `~` directory; a failed read is no home. */
async function homeFor($: EngineInterface, cls: ReturnType<typeof classify>): Promise<string | undefined> {
  const outDir = cls.kind === 'relay' ? cls.outDir : undefined
  if (!cls.workdir?.startsWith('~') && !outDir?.startsWith('~')) return undefined
  try {
    const home = await $.env.get('HOME')
    return home !== undefined && home !== '' ? home : undefined
  } catch {
    return undefined
  }
}

export function registerShellCollector(on: On, table: PriceTable): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cls = classify(typeof e.command === 'string' ? e.command : '')
    const id = 'bash:' + e.tool_use_id
    const home = await homeFor($, cls)
    const track = cls.kind !== 'shell' || e.run_in_background === true
    if (track) await send($, { type: 'bashStart', id, cls, at: Date.now(), ...(home !== undefined ? { home } : {}) }, table)

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
      if (!track) await send($, { type: 'bashStart', id, cls, at: Date.now(), ...(home !== undefined ? { home } : {}) }, table)
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

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const props = e.props
    const task = props.task
    const word = task?.status
    const status = typeof word === 'string' && Object.hasOwn(OUTCOMES, word) ? OUTCOMES[word] : undefined
    if (props.origin.kind === 'task-notification' && task && status) {
      const taskId = typeof task.id === 'string' && task.id !== '' ? task.id : undefined
      const toolUseId = typeof task.toolUseId === 'string' && task.toolUseId !== '' ? task.toolUseId : undefined
      const key = `${taskId ?? ''}|${toolUseId ?? ''}|${status}`
      if (!sentOutcomes.has(key)) {
        if (sentOutcomes.size > 1000) sentOutcomes.clear()
        sentOutcomes.add(key)
        const action: Action = {
          type: 'bgOutcome',
          ...(taskId !== undefined ? { taskId } : {}),
          ...(toolUseId !== undefined ? { runId: 'bash:' + toolUseId } : {}),
          status,
          at: Date.now(),
        }
        // state is not written while a row draws: the write waits for a timer of its own
        $.clock.after(0, () => void send($, action, table))
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
