import type { Elements } from 'claude-code'

import type { Ledger, Run, UiState, Usage } from '../../types'
import { shownCost, shownHq, storedCost, type Pricing } from '../cost'
import { utcDay } from '../history'
import { LITELLM_DATE } from '../prices-litellm'
import { cachePct, fmtCost, fmtDuration, fmtTokens } from './format'
import { countParts, groupFigures, groupIdOf, groupLabel, groupStatus, taskCount, vettedText, type Group, type GroupFigures } from './groups'
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

/** Greedy-wraps `parts` joined by " · " into lines of at most `width` cells; a part is never split. */
export function packFigures(parts: readonly string[], width: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const part of parts) {
    const joined = current === '' ? part : `${current} · ${part}`
    if (current !== '' && Array.from(joined).length > width) {
      lines.push(current)
      current = part
    } else {
      current = joined
    }
  }
  if (current !== '') lines.push(current)
  return lines.map(line => fit(line, width))
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
  // a run's Back returns to its group's dossier; a run that is gone returns to the field
  const back = (
    <Button
      key="back"
      hotkey="b"
      plain
      label="← Back"
      onPress={() => press(run ? { view: 'dossier', dossierId: groupIdOf(run) } : { view: 'field', dossierId: undefined })}
    />
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

/** HQ's dossier (id `hq`): the main loop has no status, end, lane or handlers, only its model, effort, time and figures. */
export function hqDossierView(t: Table, ledger: Ledger, now: number, inner: number, press: Press, pricing?: Pricing): ReturnType<Table['Box']> {
  const { Box, Text, Button } = t
  const back = <Button key="back" hotkey="b" plain label="← Back" onPress={() => press({ view: 'field', dossierId: undefined })} />
  const row = (label: string, value: string, valueColor?: string) => (
    <Text wrap="truncate">
      <Text dimColor>{label.padEnd(LABEL)}</Text>
      <Text color={valueColor}>{fit(value, inner - LABEL)}</Text>
    </Text>
  )
  const u = ledger.hq.usage
  const total = totalTokens(u) ?? 0
  const shown = pricing ? shownHq(ledger, pricing.mode, pricing.table, pricing.fetched) : storedCost({ cost: ledger.hq.cost, costSource: ledger.hq.cost === null ? null : 'estimated', costPartial: ledger.hq.costPartial })
  const tokensOf = (s: { usage: Usage }) => totalTokens(s.usage) ?? 0
  const byTokens = Object.entries(ledger.hqByModel ?? {}).sort(([a, x], [b, y]) => tokensOf(y) - tokensOf(x) || (a < b ? -1 : a > b ? 1 : 0))
  const models = byTokens.length > 0 ? byTokens.map(([model]) => model).join(', ') : '—'
  const effort = ledger.hqEffort === undefined ? '—' : `${ledger.hqEffort} (observed)`
  return (
    <Box flexDirection="column">
      {back}
      <Text> </Text>
      <Text bold color={PALETTE.accent}>
        HQ
      </Text>
      <Text> </Text>
      {row('kind', 'main loop')}
      {row('implementer', 'claude-code')}
      {row('model', models)}
      {row('effort', effort)}
      <Text> </Text>
      {row('started', clock(ledger.sessionStartedAt))}
      {row('duration', fmtDuration(now - ledger.sessionStartedAt))}
      <Text> </Text>
      {row('input', fmtTokens(u.uncached + u.cacheRead + u.cacheWrite))}
      {row('  uncached', fmtTokens(u.uncached))}
      {row('  cache read', fmtTokens(u.cacheRead))}
      {row('  cache write', fmtTokens(u.cacheWrite))}
      {row('output', fmtTokens(u.output))}
      {row('total', fmtTokens(total))}
      {row('cache hit', cachePct(u))}
      {row('cost', fmtCost(shown.cost, shown.source, shown.partial === true), PALETTE.accent)}
      {shown.partial === true && <Text dimColor>{'  some requests had no price'}</Text>}
    </Box>
  )
}

/** A group's status counts and task count as one dim line with the band's colors; plain dim text when it would not fit. */
export function countsLine(t: Table, figures: GroupFigures, inner: number): ReturnType<Table['Box']> {
  const { Box, Text } = t
  const parts = countParts(figures)
  const tasks = taskCount(figures.tasks)
  const whole = [...parts.map(p => p.text), tasks].join(' · ')
  if (Array.from(whole).length > inner) return <Text dimColor>{fit(whole, inner)}</Text>
  const cells = parts.flatMap(p => [<Text color={statusColor(p.status)}>{p.text}</Text>, <Text dimColor>{' · '}</Text>])
  return (
    <Box>
      {cells}
      <Text dimColor>{tasks}</Text>
    </Box>
  )
}

/**
 * A group's dossier (id `group:<key>`): the overview of every run of one implementer, model and effort, then its tasks by
 * codename. A task opens the run's own dossier. Tasks are named by codename only: no description, no free text.
 */
export function groupDossierView(
  t: Table,
  group: Group | undefined,
  ledger: Ledger,
  now: number,
  inner: number,
  g: Glyphs,
  press: Press,
  pricing: Pricing,
): ReturnType<Table['Box']> {
  const { Box, Text, Button } = t
  const back = <Button key="back" hotkey="b" plain label="← Back" onPress={() => press({ view: 'field', dossierId: undefined })} />
  if (!group) {
    return (
      <Box flexDirection="column">
        {back}
        <Text> </Text>
        <Text dimColor>That group is no longer on the board.</Text>
      </Box>
    )
  }
  const f = groupFigures(group, now, pricing)
  const status = groupStatus(group)
  const row = (label: string, value: string, valueColor?: string) => (
    <Text wrap="truncate">
      <Text dimColor>{label.padEnd(LABEL)}</Text>
      <Text color={valueColor}>{fit(value, inner - LABEL)}</Text>
    </Text>
  )
  const u = f.usage
  const part = (n: number | undefined): string => (n === undefined ? '—' : fmtTokens(n))
  return (
    <Box flexDirection="column">
      {back}
      <Text> </Text>
      <Text bold color={statusColor(status)} wrap="truncate">
        {fit(`${g.dot[status]} ${groupLabel(group)}`, inner)}
      </Text>
      {countsLine(t, f, inner)}
      <Text> </Text>
      {row('time', fmtDuration(f.elapsedMs))}
      {row('tokens', f.tokens === null ? '—' : `${f.approx ? '≈' : ''}${fmtTokens(f.tokens)}`)}
      {row('  in', part(u ? u.uncached + u.cacheRead + u.cacheWrite : undefined))}
      {row('  out', part(u?.output))}
      {row('cache hit', cachePct(u))}
      {row('cost', f.cost === null ? (f.costPartial ? '?' : '—') : fmtCost(f.cost, f.costSource, f.costPartial), PALETTE.accent)}
      {f.costPartial && <Text dimColor>{'  some requests had no price'}</Text>}
      {row('vetted', vettedText(f))}
      <Text> </Text>
      <Text bold dimColor>
        TASKS
      </Text>
      <Text> </Text>
      {group.runs.map(run => {
        const dot = g.dot[run.status]
        const spy = statusWords(run.status).spy
        const label = fit(`${run.codename}  ${run.kind} · ${run.agentType ?? run.lane ?? '—'}`, Math.max(1, inner - (Array.from(dot).length + 1)))
        const figures = [fmtDuration(runElapsed(run, now)), `${run.approx ? '≈' : ''}${runTokens(run)} tok`, runCost(run, pricing)]
        if (run.sharedSize !== undefined && run.sharedSize > 1) figures.push(`shared ×${run.sharedSize}`)
        const whole = `${spy}   ${figures.join('   ')}`
        const lines = Array.from(whole).length <= inner ? [whole] : [fit(spy, inner), ...packFigures(figures, inner)]
        const review = run.reviews.length > 0 ? run.reviews[run.reviews.length - 1] : undefined
        const handler = review
          ? `vetted by ${codenameOf(ledger, review.reviewerId)} · ${review.bugs ?? '?'} leaks · ${review.edits ?? '?'} patches`
          : run.suspectedHandlers.length > 0
            ? `suspected handler? ${codenameOf(ledger, run.suspectedHandlers[0] ?? '')}`
            : undefined
        return (
          <Box flexDirection="column" key={`task-${run.id}`}>
            <Box>
              <Text color={statusColor(run.status)} bold={run.status === 'running'}>{`${dot} `}</Text>
              <Button key={run.id} plain label={label} onPress={() => press({ view: 'dossier', dossierId: run.id })} />
            </Box>
            <Text dimColor>{lines.join('\n')}</Text>
            {handler !== undefined && <Text color={PALETTE.handler}>{fit(handler, inner)}</Text>}
          </Box>
        )
      })}
    </Box>
  )
}
