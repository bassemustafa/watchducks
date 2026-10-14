import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, On, PluginOptions } from 'claude-code'

import type { HistoryRecord, Implementer, Ledger, Run, StationRow, UiState } from '../../types'
import { shownCost, shownHq, type Pricing } from '../cost'
import { HISTORY_PREFIX, aggregateHistory, stationRowsFromLedger } from '../history'
import { seriesWindow, totals, type Totals } from '../ledger'
import { PRICES_KEY, fetchedPrices } from '../price'
import { INITIAL_LEDGER, INITIAL_UI, isHistoryRecord, pricing, withFetched } from '../state'
import { RADAR_FULL, RADAR_SMALL, blipsFor, radar, svgBlipsFor } from './animate'
import { codenameOf, dossierView, fit, runCost, runElapsed, runTokens, totalTokens, type Glyphs, type Press, type Table } from './dossier'
import { cachePct, fmtCost, fmtDuration, fmtElapsedCoarse, fmtTokens, sparkline } from './format'
import { STAMP_MS, STAMP_TEXT, TICK_MS, dotFrame, dotRaster, motion as motionState, stampRaster, tickerValue, type StampKind } from './motion'
import { duckLogo, gradientBar, hex, radarFrame, type RasterSpec } from './raster'
import { stationView } from './station'
import { BAR_HEIGHT, barSvg, barWidth, headerHeight, headerSvg, headerWidth } from './svg'
import { PALETTE, glyphs, statusColor, statusWords } from './theme'

const priceReader = fetchedPrices()

/** The prices a draw uses: the options', with the refreshed LiteLLM list from the store when there is one. */
async function pricingNow($: EngineInterface, options: PluginOptions): Promise<Pricing> {
  let record: unknown
  try {
    record = await $.store.get(PRICES_KEY)
  } catch {
    // the prices bundled with this version
  }
  return withFetched(pricing(options), priceReader(record))
}

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

type Layout = {
  columns: number
  inner: number
  tier: 'full' | 'mid' | 'compact'
  g: Glyphs
  showOverhead: boolean
  coarse: boolean
  /** The terminal element table when stamps may animate; null on the desktop and with motion off. */
  stampTable: Elements['terminal'] | null
  /** The cost mode and prices every cost on the board is shown under. */
  pricing: Pricing
}

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

function tagline(ledger: Ledger, tot: Totals): string {
  return ledger.order.length === 0 ? 'standing by' : `${tot.running} in field · ${ledger.order.length} tracked`
}

/** The text-only header of the compact tier, on both surfaces: no Raster, no Svg. */
function textHeader(t: Table, ledger: Ledger, tot: Totals): El {
  const { Box, Text } = t
  return (
    <Box flexDirection="column">
      <Text bold color={PALETTE.accent}>
        THE FLOCK
      </Text>
      <Text dimColor>{tagline(ledger, tot)}</Text>
      <Text> </Text>
      {counters(t, tot)}
    </Box>
  )
}

function cacheText(t: Table, tot: Totals): El {
  const { Text } = t
  return (
    <Text dimColor wrap="truncate">
      {`cache ${cachePct(tot.usage)}`}
    </Text>
  )
}

function spendText(t: Table, parts: ReadonlyArray<[Implementer, number]>, inner: number): El | null {
  if (parts.length === 0) return null
  const { Text } = t
  return (
    <Text dimColor wrap="truncate">
      {fit(`spend ${parts.map(([imp, v]) => `${imp} ${fmtCost(v, null, false)}`).join(' · ')}`, inner)}
    </Text>
  )
}

// ---------------------------------------------------------------- terminal

function terminalArt(t: Elements['terminal'], ledger: Ledger, tot: Totals, lay: Layout): Art {
  const { Box, Text, Raster } = t
  const tag = <Text dimColor>{tagline(ledger, tot)}</Text>
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
    header = textHeader(t, ledger, tot)
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
      if (lay.stampTable) motionState.duckMounted = true
      header = (
        <Box flexDirection="column">
          <Box>
            <Raster {...raster(duckLogo())} />
            <Box flexDirection="column" marginLeft={2}>
              {title}
              {tag}
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
          {tag}
          {blank}
          {radarRow}
        </Box>
      )
    }
  }

  const parts = spendParts(tot)
  if (lay.tier === 'compact') return { header, cacheBar: cacheText(t, tot), spendBar: spendText(t, parts, lay.inner) }
  const cacheBar = <Raster {...raster(gradientBar(cacheFraction, lay.inner, hex(PALETTE.accent), hex(PALETTE.done), 'cache'))} />
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
  if (lay.tier === 'compact') return { header: textHeader(t, ledger, tot), cacheBar: cacheText(t, tot), spendBar: spendText(t, parts, lay.inner) }
  const header = (
    <Box flexDirection="column">
      {/* an image, not an interactive frame: the desktop reloads a frame on every redraw, which flashes */}
      <Svg
        alt="The flock radar"
        width={headerWidth(px)}
        height={headerHeight(px)}
        source={headerSvg({ blips: svgBlipsFor(ledger), motion, width: px, logo: lay.tier === 'full' })}
      />
      <Text> </Text>
      {counters(t, tot)}
    </Box>
  )
  const cacheBar = (
    <Svg
      alt="Cache hit share of input"
      width={barWidth(barPx)}
      height={BAR_HEIGHT}
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
        alt="Spend by implementer"
        width={barWidth(barPx)}
        height={BAR_HEIGHT}
        source={barSvg(
          parts.map(([imp, v]) => ({ label: imp, value: v, color: IMPLEMENTER_COLORS[imp] ?? PALETTE.ended })),
          barPx,
        )}
      />
    )
  return { header, cacheBar, spendBar }
}

// -------------------------------------------------------------- field view

/** Greedy-wraps `parts` joined by " · " into lines of at most `width` cells; a part is never split. */
function packFigures(parts: readonly string[], width: number): string[] {
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

function hexOf(kind: StampKind): string {
  return kind === 'done' ? PALETTE.done : kind === 'failed' ? PALETTE.failed : PALETTE.ended
}

function stampOf(ui: UiState, runId: string, now: number): { kind: StampKind; progress: number } | undefined {
  const s = ui.stamps && Object.hasOwn(ui.stamps, runId) ? ui.stamps[runId] : undefined
  // the progress a redraw shows; the animation timer reveals the rest between redraws
  return s && s.until > now ? { kind: s.kind, progress: 1 - (s.until - now) / STAMP_MS } : undefined
}

function card(t: Table, ledger: Ledger, run: Run, now: number, inner: number, g: Glyphs, stamp: { kind: StampKind; progress: number } | undefined, stampTable: Elements['terminal'] | null, press: Press, coarse: boolean, pr: Pricing): El {
  const { Box, Text, Button } = t
  const color = statusColor(run.status)
  const words = statusWords(run.status)
  const dot = g.dot[run.status]
  if (stampTable && run.status === 'running') motionState.dots.push(run.id)
  const rest = fit(`${run.codename}  ${run.implementer} · ${run.model ?? '—'} · ${run.effort ?? '—'}`, Math.max(1, inner - (Array.from(dot).length + 1)))

  const review = run.reviews.length > 0 ? run.reviews[run.reviews.length - 1] : undefined
  let line2: El
  if (stamp) {
    if (stampTable) {
      const Raster = stampTable.Raster
      motionState.stamps[run.id] = { kind: stamp.kind, startedAt: now - stamp.progress * STAMP_MS }
      line2 = <Raster {...raster(stampRaster(run.id, stamp.kind, stamp.progress))} />
    } else {
      line2 = (
        <Text bold color={hexOf(stamp.kind)}>
          {STAMP_TEXT[stamp.kind]}
        </Text>
      )
    }
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
    const status = `${words.spy} · ${words.plain}`
    // the terminal counts up while a ticker runs; the desktop and motion off always show the ledger value
    const tick = stampTable && run.status === 'running' && Object.hasOwn(motionState.tickers, run.id) ? motionState.tickers[run.id] : undefined
    const live = tick && now - tick.startedAt < TICK_MS ? tickerValue(tick, now) : undefined
    const tokens = live ? fmtTokens(live.tokens) : runTokens(run)
    const shown = shownCost(run, pr.mode, pr.table, pr.fetched)
    const cost = live && shown.cost !== null ? fmtCost(live.cost, shown.source, shown.partial === true) : runCost(run, pr)
    const figures = [(coarse && run.status === 'running' ? fmtElapsedCoarse : fmtDuration)(runElapsed(run, now)), `${run.approx ? '≈' : ''}${tokens} tok`, cost]
    if (run.sharedSize !== undefined && run.sharedSize > 1) figures.push(`shared ×${run.sharedSize}`)
    const whole = `${status}   ${figures.join('   ')}`
    // too long for one line: the status keeps its own line, the figures wrap whole so tokens and cost never get cut
    const lines = Array.from(whole).length <= inner ? [whole] : [fit(status, inner), ...packFigures(figures, inner)]
    line2 = <Text dimColor>{lines.join('\n')}</Text>
  }
  return (
    <Box key={`card-${run.id}`} flexDirection="column">
      <Box>
        {stampTable && run.status === 'running' ? (
          <Box>
            <stampTable.Raster {...raster(dotRaster(run.id, g.on, dotFrame(now).color))} />
            <Text>{' '}</Text>
          </Box>
        ) : (
          <Text color={color} bold={run.status === 'running'}>{`${dot} `}</Text>
        )}
        <Button key={run.id} plain label={rest} onPress={() => press({ view: 'dossier', dossierId: run.id })} />
      </Box>
      {line2}
    </Box>
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
  const tot = totals(ledger, lay.pricing)
  const runs = orderedRuns(ledger)
  const delegated = totalTokens(tot.usage) ?? 0
  const series = sparkline(seriesWindow(ledger, now, 30), Math.min(15, Math.max(4, inner - LABEL - 2)))
  const parts = spendParts(tot)

  const kv = (label: string, value: string, color?: string) => (
    <Text wrap="truncate">
      <Text dimColor>{label.padEnd(LABEL)}</Text>
      <Text bold color={color}>
        {value}
      </Text>
    </Text>
  )
  const hq = ledger.hq
  const hqTokens = totalTokens(hq.usage) ?? 0
  const hqShown = shownHq(ledger, lay.pricing.mode, lay.pricing.table, lay.pricing.fetched)
  const hqLine = `HQ  ${hqTokens > 0 ? fmtTokens(hqTokens) + ' tok' : '—'} · ${hqTokens > 0 ? fmtCost(hqShown.cost, hqShown.source, hqShown.partial === true) : '—'}`
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
          {card(t, ledger, run, now, inner, g, stampOf(ui, run.id, now), lay.stampTable, press, lay.coarse, lay.pricing)}
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
    const pr = await pricingNow($, options)
    const columns = e.props.bodyColumns > 0 ? e.props.bodyColumns : e.viewport?.columns && e.viewport.columns > 0 ? e.viewport.columns : DEFAULT_COLUMNS
    const tier = columns >= 48 ? 'full' : columns >= 36 ? 'mid' : 'compact'
    const lay: Layout = { columns, inner: Math.max(16, columns - PAD * 2), tier, g, showOverhead, coarse: e.surface === 'desktop', stampTable: e.surface === 'terminal' && motion ? $.ui.resolve(e) : null, pricing: pr }
    const press: Press = patch => void update($, uiAtom, u => ({ ...u, ...patch })).catch(() => undefined)
    radar.mounted = null
    motionState.dots = []
    motionState.stamps = {}
    motionState.duckMounted = false

    const t: Table = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const blank = <Text> </Text>
    const tab = (key: string, hotkey: string, label: string, view: UiState['view']) => (
      <Box key={`tab-${key}`}>
        {ui.view === view ? (
          <Text bold color={PALETTE.accent}>
            {'▸ '}
          </Text>
        ) : (
          <Text>{'  '}</Text>
        )}
        <Button key={key} hotkey={hotkey} plain label={label} onPress={() => press({ view, dossierId: undefined })} />
      </Box>
    )
    const nav = (
      <Box>
        {tab('field', 'f', 'Field', 'field')}
        <Text>{'    '}</Text>
        {tab('station', 's', 'Station', 'station')}
      </Box>
    )

    let body: El
    if (ui.view === 'dossier') {
      const run = ui.dossierId !== undefined && Object.hasOwn(ledger.runs, ui.dossierId) ? ledger.runs[ui.dossierId] : undefined
      body = dossierView(t, run, ledger, now, lay.inner, g, press, pr)
    } else if (ui.view === 'station') {
      const rows =
        ui.span === '30d'
          ? await historyRows(
              () => $.store.keys(),
              key => $.store.get(key),
              now,
            )
          : stationRowsFromLedger(ledger, pr)
      body = (
        <Box flexDirection="column">
          {nav}
          {blank}
          {stationView(t, rows, ui.span, lay.inner, g, press, e.surface === 'terminal' ? null : $.ui.resolve(e))}
        </Box>
      )
    } else {
      const tot = totals(ledger, pr)
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
