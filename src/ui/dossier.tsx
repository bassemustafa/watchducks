import type { Elements } from 'claude-code'

import type { Ledger, Run, UiState, Usage } from '../../types'
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
  if (run.kind === 'relay' && run.implementer !== 'claude') return '—'
  return '?'
}

export function runCost(run: Run): string {
  if (run.cost === null && run.costSource === null) {
    if (run.kind === 'cli' || run.kind === 'shell') return '—'
    if (run.kind === 'relay' && run.implementer === 'codex') return '—'
  }
  return fmtCost(run.cost, run.costSource, run.costPartial)
}

export function runElapsed(run: Run, now: number): number {
  if (run.status === 'running') return now - run.startedAt
  return run.durationMs ?? (run.endedAt !== undefined ? run.endedAt - run.startedAt : Number.NaN)
}

export function codenameOf(ledger: Ledger, id: string): string {
  const run = Object.hasOwn(ledger.runs, id) ? ledger.runs[id] : undefined
  return run ? run.codename : '?'
}

function clock(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—'
  return new Date(ms).toISOString().slice(11, 19) + ' UTC'
}

const LABEL = 12

export function dossierView(
  t: Table,
  run: Run | undefined,
  ledger: Ledger,
  now: number,
  inner: number,
  g: Glyphs,
  press: Press,
): ReturnType<Table['Box']> {
  const { Box, Text, Button } = t
  const back = (
    <Button key="back" hotkey="b" plain onPress={() => press({ view: 'field', dossierId: undefined })}>
      <Text color={PALETTE.accent}>← Back</Text>
    </Button>
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
      <Text color={valueColor ?? PALETTE.text}>{fit(value, inner - LABEL)}</Text>
    </Text>
  )

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
      {row('uncached', u ? fmtTokens(u.uncached) : runTokens(run))}
      {row('cache read', u ? fmtTokens(u.cacheRead) : runTokens(run))}
      {row('cache write', u ? fmtTokens(u.cacheWrite) : runTokens(run))}
      {row('output', u ? fmtTokens(u.output) : runTokens(run))}
      {row('cache hit', cachePct(u))}
      {row('cost', runCost(run), PALETTE.accent)}
      {run.costPartial && <Text dimColor>{'  some requests had no price'}</Text>}
      <Text> </Text>
      {row('patches', String(run.editCalls))}
      {row('leaks', String(run.bugsReported))}
      {reviews.length === 0 && suspects.length === 0 && row('handler', 'none recorded')}
      {reviews.map(line => row('handler', line, PALETTE.handler))}
      {suspects.length > 0 && row('suspected', 'handler? ' + suspects.join(', '), PALETTE.handler)}
    </Box>
  )
}
