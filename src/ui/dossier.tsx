import type { Elements } from 'claude-code'

import type { Ledger, Run, UiState, Usage } from '../../types'
import { shownCost, storedCost, type Pricing } from '../cost'
import { utcDay } from '../history'
import { LITELLM_DATE } from '../prices-litellm'
import { cachePct, fmtCost, fmtDuration, fmtTokens } from './format'
import { PALETTE, glyphs, statusColor, statusWords } from './theme'

// Pure tree builders (spec §9.2): they take values the render hook already
// read and the element table, never `$`. Only codenames, numbers and enums are
// shown; no event text exists in the ledger to leak.

export type Table = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
export type Glyphs = ReturnType<typeof glyphs>
/** Applies a change to the ui state; built beside `$` in the render hook. */
export type Press = (patch: Partial<UiState>) => void

/** Cut `text` to `width` cells with an ellipsis. */
export function fit(text: string, width: number): string {
  const w = Math.max(1, Math.floor(width))
  const chars = Array.from(text)
  return chars.length <= w ? text : chars.slice(0, w - 1).join('') + '…'
}

export function totalTokens(u: Usage | null): number | null {
  return u ? u.uncached + u.output + u.cacheRead + u.cacheWrite : null
}

/** Tokens for a run: a number, "—" when the source has none, "?" when it should but is unknown. */
export function runTokens(run: Run): string {
  const total = totalTokens(run.usage)
  if (total !== null) return fmtTokens(total)
  if (run.kind === 'cli' || run.kind === 'shell') return '—'
  if (run.kind === 'relay' && (run.implementer !== 'claude' || run.outDir === undefined)) return '—'
  return '?'
}

/**
 * The run's cost text under `pricing` (the stored figures when none is given). `detail` adds what a card leaves out, in
 * brackets after the figure: that a reported $0 was replaced, and the date of the LiteLLM prices an estimate used. The
 * brackets are the longest wording that fits `width` (cells); the figure is never cut.
 */
export function runCost(run: Run, pricing?: Pricing, detail = false, width = Number.POSITIVE_INFINITY): string {
  const shown = pricing ? shownCost(run, pricing.mode, pricing.table, pricing.fetched) : storedCost(run)
  if (shown.cost === null && shown.source === null) {
    if (run.kind === 'cli' || run.kind === 'shell') return '—'
    // a relay without an out dir has no result file to read, so its cost can never arrive
    if (run.kind === 'relay' && (run.implementer === 'codex' || run.outDir === undefined)) return '—'
  }
  const text = fmtCost(shown.cost, shown.source, shown.partial === true)
  if (!detail) return text
  const zero = shown.reportedZero ? 'reported $0' : undefined
  const date =
    shown.list === undefined ? undefined : shown.list === 'fetched' && pricing?.fetchedAt !== undefined ? utcDay(pricing.fetchedAt) : LITELLM_DATE
  const notes = [
    [zero, date && `LiteLLM prices of ${date}`],
    [zero, date && `LiteLLM ${date}`],
    [zero],
    [date && `LiteLLM ${date}`],
  ].map(parts => parts.filter(Boolean).join('; '))
  const note = notes.find(n => n !== '' && Array.from(text).length + 3 + Array.from(n).length <= width)
  return note === undefined ? text : `${text} (${note})`
}

const SOURCE_WORDS = { relay: 'result.json', child: 'child report', stats: 'opencode stats', steps: 'per request', complete: 'per request' } as const

/** Where a run's numbers came from, with the approximate mark; "—" when it has no numbers yet. */
export function runSource(run: Run): string {
  if (run.usageSource === null) return '—'
  return SOURCE_WORDS[run.usageSource] + (run.approx ? ' (approximate)' : '')
}

export function runElapsed(run: Run, now: number): number {
  if (run.status === 'running') return now - run.startedAt
  return run.durationMs ?? (run.endedAt !== undefined ? run.endedAt - run.startedAt : Number.NaN)
}

export function codenameOf(ledger: Ledger, id: string): string {
  const run = Object.hasOwn(ledger.runs, id) ? ledger.runs[id] : undefined
  if (run) return run.codename
  return id === 'hq' ? 'HQ' : '?'
}

function clock(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—'
  return new Date(ms).toISOString().slice(11, 19) + ' UTC'
}

const LABEL = 14

export function dossierView(
  t: Table,
  run: Run | undefined,
  ledger: Ledger,
  now: number,
  inner: number,
  g: Glyphs,
  press: Press,
  pricing?: Pricing,
): ReturnType<Table['Box']> {
  const { Box, Text, Button } = t
  const back = (
    <Button key="back" hotkey="b" plain label="← Back" onPress={() => press({ view: 'field', dossierId: undefined })} />
  )
  if (!run) {
    return (
      <Box flexDirection="column">
        {back}
        <Text> </Text>
        <Text dimColor>That operative is no longer on the board.</Text>
      </Box>
    )
  }

  const words = statusWords(run.status)
  const color = statusColor(run.status)
  const row = (label: string, value: string, valueColor?: string) => (
    <Text wrap="truncate">
      <Text dimColor>{label.padEnd(LABEL)}</Text>
      <Text color={valueColor}>{fit(value, inner - LABEL)}</Text>
    </Text>
  )

  const costShown = pricing ? shownCost(run, pricing.mode, pricing.table, pricing.fetched) : storedCost(run)
  const u = run.usage
  const models = run.models && run.models.length > 0 ? run.models.join(', ') : (run.model ?? '—')
  const effort =
    run.effort === undefined ? '—' : run.effortSource ? `${run.effort} (${run.effortSource})` : String(run.effort)

  const reviews = run.reviews.map(r => {
    const who = codenameOf(ledger, r.reviewerId)
    return `vetted by ${who} · ${r.bugs ?? '?'} leaks · ${r.edits ?? '?'} patches`
  })
  const suspects = run.suspectedHandlers.map(id => codenameOf(ledger, id))

  return (
    <Box flexDirection="column">
      {back}
      <Text> </Text>
      <Text bold color={color}>
        {g.dot[run.status]} {run.codename}
      </Text>
      <Text color={color}>
        {words.spy} · {words.plain}
      </Text>
      <Text> </Text>
      {row('kind', run.kind)}
      {row('agent type', run.agentType ?? '—')}
      {row('lane', run.lane ?? '—')}
      {row('implementer', run.implementer)}
      {row('model', models)}
      {row('effort', effort)}
      {row('read-only', run.readOnly ? 'yes' : 'no')}
      <Text> </Text>
      {row('started', clock(run.startedAt))}
      {row('ended', run.status === 'running' ? '—' : clock(run.endedAt))}
      {row('duration', fmtDuration(runElapsed(run, now)))}
      <Text> </Text>
      {run.usageSource !== null && row('source', runSource(run))}
      {run.sharedSize !== undefined && run.sharedSize > 1 && row('shared', `even share of ${run.sharedSize} runs`)}
      {row('input', u ? fmtTokens(u.uncached + u.cacheRead + u.cacheWrite) : runTokens(run))}
      {row('  uncached', u ? fmtTokens(u.uncached) : runTokens(run))}
      {row('  cache read', u ? fmtTokens(u.cacheRead) : runTokens(run))}
      {row('  cache write', u ? fmtTokens(u.cacheWrite) : runTokens(run))}
      {row('output', u ? fmtTokens(u.output) : runTokens(run))}
      {row('total', runTokens(run))}
      {row('cache hit', cachePct(u))}
      {row('cost', runCost(run, pricing, true, inner - LABEL), PALETTE.accent)}
      {costShown.partial === true && <Text dimColor>{'  some requests had no price'}</Text>}
      <Text> </Text>
      {row('patches', String(run.editCalls))}
      {row('leaks', String(run.bugsReported))}
      {reviews.length === 0 && suspects.length === 0 && row('handler', 'none recorded')}
      {reviews.map(line => row('handler', line, PALETTE.handler))}
      {suspects.length > 0 && row('suspected', 'handler? ' + suspects.join(', '), PALETTE.handler)}
    </Box>
  )
}
