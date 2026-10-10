import { atom, read } from 'claude-code'
import type { On, PluginOptions } from 'claude-code'

import { totals } from '../ledger'
import { INITIAL_LEDGER } from '../state'
import { radar } from './animate'
import { totalTokens } from './dossier'
import { cachePct, fmtCost, fmtTokens } from './format'
import { PALETTE, glyphs } from './theme'

const ledgerAtom = atom({ plugin: 'watchducks', key: 'ledger' } as const, INITIAL_LEDGER)

// The band above the prompt (spec §9.3): one line while the sidebar is not
// shown and a run is running or one ended within the last five minutes.

const RECENT_MS = 5 * 60_000

export function registerBand(on: On, options: PluginOptions): void {
  const g = glyphs(options.glyphs === 'ascii' ? 'ascii' : 'emoji')

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (typeof e.viewport?.isFullscreen === 'boolean') radar.fullscreen = e.viewport.isFullscreen
    if (e.props.hasSurvey) return next(e)

    const ledger = await read($, ledgerAtom)
    const now = Date.now()
    const live = ledger.order.some(id => {
      const run = ledger.runs[id]
      return run !== undefined && (run.status === 'running' || (run.endedAt !== undefined && now - run.endedAt < RECENT_MS))
    })
    if (!live) return next(e)

    let placed = false
    try {
      placed = (await $.ui.panes()).some(p => p.id === 'flock' && p.isPlaced)
    } catch {
      // unknown placement: show the band
    }
    if (placed) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const tot = totals(ledger)
    const tokens = totalTokens(tot.usage) ?? 0
    return (
      <Box>
        <Text bold color={PALETTE.accent}>
          {g.duck} FLOCK
        </Text>
        <Text>{'  '}</Text>
        <Text color={PALETTE.running}>{`▸ ${tot.running} in field`}</Text>
        <Text dimColor>{' · '}</Text>
        <Text color={PALETTE.done}>{`${tot.done} debriefed`}</Text>
        <Text dimColor>{' · '}</Text>
        <Text color={PALETTE.failed}>{`${tot.failed} dark`}</Text>
        <Text>{'   '}</Text>
        <Text>{`${fmtTokens(tokens)} tok · ${cachePct(tot.usage)} cache · ${fmtCost(tot.cost, null, tot.costPartial)}`}</Text>
        <Text dimColor>{'   /flock'}</Text>
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
