import { atom, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'

import type { UiState } from '../types'
import { HISTORY_PREFIX } from './history'
import { reduce } from './ledger'
import type { PriceTable } from './price'
import { INITIAL_LEDGER, INITIAL_UI } from './state'
import { glyphs } from './ui/theme'

const ledgerAtom = atom({ plugin: 'watchducks', key: 'ledger' } as const, INITIAL_LEDGER)
const uiAtom = atom({ plugin: 'watchducks', key: 'ui' } as const, INITIAL_UI)

// `/flock` (spec §9.5): open the sidebar, open it on the station board, clear
// the ended runs, or purge the stored history. The command answers itself.

const PANE = 'flock'
const WATCH = 'The flock is on watch'

async function openPane($: EngineInterface, title: string): Promise<boolean> {
  try {
    await $.ui.open({ id: PANE, title, columns: 52 })
    // opened by hand counts as the session's open: auto-open stays out of the way
    await update($, uiAtom, u => ({ ...u, autoOpened: true }))
    return true
  } catch {
    return false
  }
}

async function purgeHistory($: EngineInterface): Promise<number> {
  let removed = 0
  try {
    for (const key of await $.store.keys()) {
      if (!key.startsWith(HISTORY_PREFIX)) continue
      await $.store.delete(key)
      removed += 1
    }
  } catch {
    // report what was removed so far
  }
  return removed
}

export function registerCommands(on: On, table: PriceTable, options: PluginOptions): void {
  const title = `${glyphs(options.glyphs === 'ascii' ? 'ascii' : 'emoji').duck} The Flock`

  on('command.run', { command: 'flock' }, async ($, e) => {
    const arg = typeof e.args === 'string' ? e.args.trim().toLowerCase() : ''

    if (arg === 'clear') {
      try {
        await update($, ledgerAtom, l => reduce(l, { type: 'clear', at: Date.now() }, table))
      } catch {
        // the board keeps what it had
      }
      return { text: `${WATCH} — ended runs cleared from the board.` }
    }

    if (arg === 'purge') {
      const removed = await purgeHistory($)
      return { text: `${WATCH} — history purged: ${removed} ${removed === 1 ? 'record' : 'records'} removed.` }
    }

    if (arg === 'station') {
      try {
        await update($, uiAtom, (u): UiState => ({ ...u, view: 'station', dossierId: undefined }))
      } catch {
        // the pane opens on whatever view it had
      }
    }
    const opened = await openPane($, title)
    return { text: opened ? `${WATCH} — sidebar opened.` : `${WATCH} — the sidebar cannot open here.` }
  })
}
