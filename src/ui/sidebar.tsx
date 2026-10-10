import { atom, read, update } from 'claude-code'
import type { Elements, On, PluginOptions } from 'claude-code'

import type { HistoryRecord, Implementer, Ledger, Run, StationRow, UiState } from '../../types'
import { HISTORY_PREFIX, aggregateHistory, stationRowsFromLedger } from '../history'
import { totals, type Totals } from '../ledger'
import { INITIAL_LEDGER, INITIAL_UI, isHistoryRecord } from '../state'
import { RADAR_FULL, RADAR_SMALL, blipsFor, radar, svgBlipsFor } from './animate'
import { codenameOf, dossierView, fit, runCost, runElapsed, runTokens, totalTokens, type Glyphs, type Press, type Table } from './dossier'
import { cachePct, fmtCost, fmtDuration, fmtTokens, sparkline } from './format'
import { duckLogo, gradientBar, hex, radarFrame, type RasterSpec } from './raster'
import { stationView } from './station'
import { barSvg, headerSvg } from './svg'
import { PALETTE, glyphs, statusColor, statusWords } from './theme'

const ledgerAtom = atom({ plugin: 'watchducks', key: 'ledger' } as const, INITIAL_LEDGER)
const uiAtom = atom({ plugin: 'watchducks', key: 'ui' } as const, INITIAL_UI)

// The flock sidebar (spec §9.2). Two columns of side padding, one blank row
// between sections and between cards. Width tiers: >= 48 full, 36-47 no duck
// and a small radar, < 36 text only. The tree is built from the ledger and the
// ui state: codenames, numbers and enums, never event text.

const PANE = 'flock'
const DEFAULT_COLUMNS = 52
const PAD = 2
const LABEL = 8

type El = ReturnType<Table['Box']>

const IMPLEMENTER_COLORS: Record<Implementer, string> = {
  'claude-code': '#2dd4bf',
  claude: '#a78bfa',
  opencode: '#60a5fa',
  codex: '#f472b6',
  gemini: '#fb923c',
  shell: '#94a3b8',
  unknown: '#64748b',
}

/** Running runs newest first, then ended ones newest first. */
function orderedRuns(ledger: Ledger): Run[] {
  const runs: Run[] = []
  for (const id of ledger.order) {
    const run = Object.hasOwn(ledger.runs, id) ? ledger.runs[id] : undefined
    if (run) runs.push(run)
  }
  const running = runs.filter(r => r.status === 'running').sort((a, b) => b.startedAt - a.startedAt)
  const ended = runs.filter(r => r.status !== 'running').sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
  return [...running, ...ended]
}

function raster(spec: RasterSpec): { key: string; columns: number; rows: number; cells: string } {
  return { key: spec.key, columns: spec.columns, rows: spec.rows, cells: spec.cells }
}

type Layout = { columns: number; inner: number; tier: 'full' | 'mid' | 'compact'; g: Glyphs; showOverhead: boolean }

/** What the surface-specific part of the field view contributes. */
type Art = { header: El; cacheBar: El; spendBar: El | null }

// ------------------------------------------------------------------ shared

function counters(t: Table, tot: Totals): El {
  const { Box, Text } = t
  const line = (label: string, n: number, color: string) => (
    <Text wrap="truncate">
      <Text dimColor>{label.padEnd(11)}</Text>
      <Text bold color={color}>
        {String(n).padStart(3)}
      </Text>
    </Text>
  )
  return (
    <Box flexDirection="column">
      {line(statusWords('running').spy, tot.running, statusColor('running'))}
      {line(statusWords('done').spy, tot.done, statusColor('done'))}
      {line(statusWords('failed').spy, tot.failed, statusColor('failed'))}
      {tot.killed > 0 && line(statusWords('killed').spy, tot.killed, statusColor('killed'))}
      {tot.ended > 0 && line(statusWords('ended').spy, tot.ended, statusColor('ended'))}
      {tot.unknown > 0 && line(statusWords('unknown').spy, tot.unknown, statusColor('unknown'))}
    </Box>
  )
}

function textBar(t: Table, fraction: number, width: number): El {
  const { Text } = t
  const n = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return (
    <Text>
      <Text color={PALETTE.accent}>{'█'.repeat(n)}</Text>
      <Text color={PALETTE.ended}>{'░'.repeat(width - n)}</Text>
    </Text>
  )
}

function textSpendBar(t: Table, parts: ReadonlyArray<[string, number]>, width: number): El {
  const { Box, Text } = t
  const sum = parts.reduce((a, [, v]) => a + v, 0)
  let used = 0
  const cells = parts.map(([color, v], i) => {
    const n = i === parts.length - 1 ? width - used : Math.max(1, Math.round((v / sum) * width))
    used += n
    return <Text color={color}>{'█'.repeat(Math.max(0, n))}</Text>
  })
  return <Box>{cells}</Box>
}

function spendParts(tot: Totals): Array<[Implementer, number]> {
  return (Object.entries(tot.byImplementer) as Array<[Implementer, number]>)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
}

// ---------------------------------------------------------------- terminal

function terminalArt(t: Elements['terminal'], ledger: Ledger, tot: Totals, lay: Layout): Art {
  const { Box, Text, Raster } = t
  const tagline = (
    <Text dimColor>{ledger.order.length === 0 ? 'standing by' : `${tot.running} in field · ${ledger.order.length} tracked`}</Text>
  )
  const title = (
    <Text bold color={PALETTE.accent}>
      THE FLOCK
    </Text>
  )
  const blank = <Text> </Text>
  const input = tot.usage.uncached + tot.usage.cacheRead + tot.usage.cacheWrite
  const cacheFraction = input > 0 ? tot.usage.cacheRead / input : 0

  let header: El
  if (lay.tier === 'compact') {
    header = (
      <Box flexDirection="column">
        {title}
        {tagline}
        {blank}
        {counters(t, tot)}
      </Box>
    )
  } else {
    const size = lay.tier === 'full' ? RADAR_FULL : RADAR_SMALL
    radar.mounted = { columns: size.columns, rows: size.rows }
    const frame = radarFrame(radar.tick, blipsFor(ledger), size.columns, size.rows)
    const radarRow = (
      <Box>
        <Raster {...raster(frame)} />
        <Box flexDirection="column" marginLeft={2}>
          {counters(t, tot)}
        </Box>
      </Box>
    )
    if (lay.tier === 'full') {
      header = (
        <Box flexDirection="column">
          <Box>
            <Raster {...raster(duckLogo())} />
            <Box flexDirection="column" marginLeft={2}>
              {title}
              {tagline}
            </Box>
          </Box>
          {blank}
          {radarRow}
        </Box>
      )
    } else {
      header = (
        <Box flexDirection="column">
          {title}
          {tagline}
          {blank}
          {radarRow}
        </Box>
      )
    }
  }

  const cacheBar = <Raster {...raster(gradientBar(cacheFraction, lay.inner, hex(PALETTE.accent), hex(PALETTE.done), 'cache'))} />
  const parts = spendParts(tot)
  const spendBar =
    parts.length === 0
      ? null
      : textSpendBar(
          t,
          parts.map(([imp, v]) => [IMPLEMENTER_COLORS[imp] ?? PALETTE.ended, v] as [string, number]),
          lay.inner,
        )
  return { header, cacheBar, spendBar }
}

// ----------------------------------------------------------------- desktop

function desktopArt(t: Elements['desktop'], ledger: Ledger, tot: Totals, lay: Layout, motion: boolean): Art {
  const { Box, Text, Svg } = t
  const px = Math.max(280, Math.min(1200, lay.columns * 8))
  const barPx = Math.max(120, lay.inner * 8)
  const input = tot.usage.uncached + tot.usage.cacheRead + tot.usage.cacheWrite
  const parts = spendParts(tot)
  const header = (
    <Box flexDirection="column">
      <Svg
        isInteractive
        alt="The flock radar"
        width={px}
        source={headerSvg({ blips: svgBlipsFor(ledger), motion, width: px })}
      />
      <Text> </Text>
      {counters(t, tot)}
    </Box>
  )
  const cacheBar = (
    <Svg
      isInteractive
      alt="Cache hit share of input"
      width={barPx}
      source={barSvg(
        [
          { label: 'cache read', value: tot.usage.cacheRead, color: PALETTE.accent },
          { label: 'other input', value: Math.max(0, input - tot.usage.cacheRead), color: PALETTE.ended },
        ],
        barPx,
      )}
    />
  )
  const spendBar =
    parts.length === 0 ? null : (
      <Svg
        isInteractive
        alt="Spend by implementer"
        width={barPx}
        source={barSvg(
          parts.map(([imp, v]) => ({ label: imp, value: v, color: IMPLEMENTER_COLORS[imp] ?? PALETTE.ended })),
          barPx,
        )}
      />
    )
  return { header, cacheBar, spendBar }
}

// -------------------------------------------------------------- field view

function card(t: Table, ledger: Ledger, run: Run, now: number, inner: number, g: Glyphs, stamped: boolean, press: Press): El {
  const { Text, Button } = t
  const color = statusColor(run.status)
  const words = statusWords(run.status)
  const line1 = fit(`${g.dot[run.status]} ${run.codename}  ${run.implementer} · ${run.model ?? '—'} · ${run.effort ?? '—'}`, inner)

  const review = run.reviews.length > 0 ? run.reviews[run.reviews.length - 1] : undefined
  let line2: El
  if (stamped) {
    line2 = (
      <Text bold color={PALETTE.done}>
        {'✦ DEBRIEFED ✦'}
      </Text>
    )
  } else if (run.status !== 'running' && review) {
    line2 = (
      <Text color={PALETTE.handler}>
        {fit(`vetted by ${codenameOf(ledger, review.reviewerId)} · ${review.bugs ?? '?'} leaks · ${review.edits ?? '?'} patches`, inner)}
      </Text>
    )
  } else if (run.status !== 'running' && run.suspectedHandlers.length > 0) {
    const id = run.suspectedHandlers[0] ?? ''
    line2 = <Text color={PALETTE.handler}>{fit(`suspected handler? ${codenameOf(ledger, id)}`, inner)}</Text>
  } else {
    line2 = (
      <Text dimColor>
        {fit(
          `${words.spy} · ${words.plain}   ${fmtDuration(runElapsed(run, now))}   ${runTokens(run)} tok   ${runCost(run)}`,
          inner,
        )}
      </Text>
    )
  }
  return (
    <Button key={run.id} plain onPress={() => press({ view: 'dossier', dossierId: run.id })}>
      <Text color={color} bold={run.status === 'running'}>
        {line1}
      </Text>
      {'\n'}
      {line2}
    </Button>
  )
}

function fieldView(
  t: Table,
  ledger: Ledger,
  ui: UiState,
  now: number,
  lay: Layout,
  art: Art,
  press: Press,
): El {
  const { Box, Text } = t
  const { inner, g } = lay
  const blank = <Text> </Text>
  const tot = totals(ledger)
  const runs = orderedRuns(ledger)
  const delegated = totalTokens(tot.usage) ?? 0
  const series = sparkline(ledger.tokenSeries, Math.min(15, Math.max(4, inner - LABEL - 2)))
  const stampId = ui.stamp && ui.stamp.until > now ? ui.stamp.runId : undefined
  const parts = spendParts(tot)

  const kv = (label: string, value: string, color?: string) => (
    <Text wrap="truncate">
      <Text dimColor>{label.padEnd(LABEL)}</Text>
      <Text bold color={color ?? PALETTE.text}>
        {value}
      </Text>
    </Text>
  )
  const hq = ledger.hq
  const hqTokens = totalTokens(hq.usage) ?? 0
  const hqLine = `HQ  ${hqTokens > 0 ? fmtTokens(hqTokens) + ' tok' : '—'} · ${hqTokens > 0 ? fmtCost(hq.cost, 'estimated', hq.costPartial) : '—'}`
  const ohTokens = totalTokens(ledger.overhead.usage) ?? 0

  return (
    <Box flexDirection="column">
      {art.header}
      {blank}
      <Text bold dimColor>
        SIGNAL
      </Text>
      {blank}
      {series !== '' && (
        <Text wrap="truncate">
          <Text dimColor>{'tok/min'.padEnd(LABEL)}</Text>
          <Text color={PALETTE.accent}>{series}</Text>
        </Text>
      )}
      {kv('tokens', fmtTokens(delegated), PALETTE.accent)}
      {kv('cache', cachePct(tot.usage), PALETTE.accent)}
      {art.cacheBar}
      {blank}
      {kv('spend', tot.cost === null ? '—' : fmtCost(tot.cost, null, tot.costPartial), PALETTE.accent)}
      {art.spendBar}
      {parts.map(([imp, v]) => (
        <Text wrap="truncate">
          <Text color={IMPLEMENTER_COLORS[imp] ?? PALETTE.ended}>{'■ '}</Text>
          <Text dimColor>{imp.padEnd(Math.max(6, inner - 12))}</Text>
          <Text>{fmtCost(v, null, false).padStart(8)}</Text>
        </Text>
      ))}
      {blank}
      <Text dimColor wrap="truncate">
        {hqLine}
      </Text>
      {lay.showOverhead && (
        <Text dimColor wrap="truncate">
          {`engine  ${ohTokens > 0 ? fmtTokens(ohTokens) + ' tok' : '—'}`}
        </Text>
      )}
      {blank}
      <Text bold dimColor>
        OPERATIVES
      </Text>
      {blank}
      {runs.length === 0 && <Text dimColor>No operatives yet — the flock is watching.</Text>}
      {runs.map((run, i) => (
        <Box flexDirection="column" key={'card:' + run.id} marginBottom={i === runs.length - 1 ? 0 : 1}>
          {card(t, ledger, run, now, inner, g, run.id === stampId, press)}
        </Box>
      ))}
    </Box>
  )
}

async function historyRows(read1: () => Promise<string[]>, get: (key: string) => Promise<unknown>, now: number): Promise<StationRow[]> {
  const records: HistoryRecord[] = []
  try {
    for (const key of await read1()) {
      if (!key.startsWith(HISTORY_PREFIX)) continue
      const value = await get(key)
      if (isHistoryRecord(value)) records.push(value)
    }
  } catch {
    // an unreadable store shows an empty board
  }
  return aggregateHistory(records, now)
}

export function registerSidebar(on: On, options: PluginOptions): void {
  const g: Glyphs = glyphs(options.glyphs === 'ascii' ? 'ascii' : 'emoji')
  const motion = options.motion !== 'off'
  const showOverhead = options.showEngineOverhead === 'on'

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    // mobile and the editor get the band only
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    if (typeof e.viewport?.isFullscreen === 'boolean') radar.fullscreen = e.viewport.isFullscreen

    const ledger = await read($, ledgerAtom)
    const ui = await read($, uiAtom)
    const now = Date.now()
    const columns = e.props.bodyColumns > 0 ? e.props.bodyColumns : e.viewport?.columns && e.viewport.columns > 0 ? e.viewport.columns : DEFAULT_COLUMNS
    const tier = columns >= 48 ? 'full' : columns >= 36 ? 'mid' : 'compact'
    const lay: Layout = { columns, inner: Math.max(16, columns - PAD * 2), tier, g, showOverhead }
    const press: Press = patch => void update($, uiAtom, u => ({ ...u, ...patch })).catch(() => undefined)
    radar.mounted = null

    const t: Table = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const blank = <Text> </Text>
    const tab = (key: string, hotkey: string, label: string, view: UiState['view']) => (
      <Button key={key} hotkey={hotkey} plain onPress={() => press({ view, dossierId: undefined })}>
        <Text bold={ui.view === view} color={ui.view === view ? PALETTE.accent : undefined} dimColor={ui.view !== view}>
          {label}
        </Text>
      </Button>
    )
    const nav = (
      <Box>
        {tab('field', 'f', 'f Field', 'field')}
        <Text>{'    '}</Text>
        {tab('station', 's', 's Station', 'station')}
      </Box>
    )

    let body: El
    if (ui.view === 'dossier') {
      const run = ui.dossierId !== undefined && Object.hasOwn(ledger.runs, ui.dossierId) ? ledger.runs[ui.dossierId] : undefined
      body = dossierView(t, run, ledger, now, lay.inner, g, press)
    } else if (ui.view === 'station') {
      const rows =
        ui.span === '30d'
          ? await historyRows(
              () => $.store.keys(),
              key => $.store.get(key),
              now,
            )
          : stationRowsFromLedger(ledger)
      body = (
        <Box flexDirection="column">
          {nav}
          {blank}
          {stationView(t, rows, ui.span, lay.inner, g, press)}
        </Box>
      )
    } else {
      const tot = totals(ledger)
      const art = e.surface === 'terminal' ? terminalArt($.ui.resolve(e), ledger, tot, lay) : desktopArt($.ui.resolve(e), ledger, tot, lay, motion)
      body = (
        <Box flexDirection="column">
          {nav}
          {blank}
          {fieldView(t, ledger, ui, now, lay, art, press)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={PAD} paddingY={1}>
        {body}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // Closing by hand ends auto-open for the session; the close itself is never refused here.
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) {
      radar.mounted = null
      if (e.origin.kind === 'person') {
        try {
          await update($, uiAtom, u => ({ ...u, closedByPerson: true }))
        } catch {
          // the close goes through whatever the write does
        }
      }
    }
    return result
  }).catch(($, e, next) => next(e))
}
