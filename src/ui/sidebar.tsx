import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, On, PluginOptions } from 'claude-code'

import type { HistoryRecord, Implementer, Ledger, StationRow, UiState } from '../../types'
import { fnv1a } from '../codename'
import { hqModelOf, shownCost, shownHq, type Pricing } from '../cost'
import { HISTORY_PREFIX, aggregateHistory, stationRowsFromLedger } from '../history'
import { seriesWindow, totals, type Totals } from '../ledger'
import { PRICES_KEY, fetchedPrices } from '../price'
import { INITIAL_LEDGER, INITIAL_UI, isHistoryRecord, pricing, withFetched } from '../state'
import { RADAR_FULL, RADAR_SMALL, blipsFor, radar, svgBlipsFor } from './animate'
import { countsLine, dossierView, groupDossierView, hqDossierView, fit, packFigures, totalTokens, type Glyphs, type Press, type Table } from './dossier'
import { cachePct, fmtCost, fmtDuration, fmtElapsedCoarse, fmtTokens, sparkline } from './format'
import { GROUP_PREFIX, groupFigures, groupLabel, groupStatus, groupsOf, type Group } from './groups'
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

function hexOf(kind: StampKind): string {
  return kind === 'done' ? PALETTE.done : kind === 'failed' ? PALETTE.failed : PALETTE.ended
}

function stampOf(ui: UiState, runId: string, now: number): { kind: StampKind; progress: number } | undefined {
  const s = ui.stamps && Object.hasOwn(ui.stamps, runId) ? ui.stamps[runId] : undefined
  // the progress a redraw shows; the animation timer reveals the rest between redraws
  return s && s.until > now ? { kind: s.kind, progress: 1 - (s.until - now) / STAMP_MS } : undefined
}

/** The id a group's dot and stamp Rasters are keyed by: short, and free of the characters of the group id. */
function motionId(group: Group): string {
  return 'g' + fnv1a(group.id).toString(16)
}

/** The group's newest active stamp (the one with the least progress); the stamps stay keyed by run id. */
function groupStamp(ui: UiState, group: Group, now: number): { kind: StampKind; progress: number } | undefined {
  let newest: { kind: StampKind; progress: number } | undefined
  for (const run of group.runs) {
    const s = stampOf(ui, run.id, now)
    if (s && (newest === undefined || s.progress < newest.progress)) newest = s
  }
  return newest
}

/** One card per implementer · model · effort: the label as the button, the status counts, then time, tokens and cost. */
function groupCard(t: Table, group: Group, ui: UiState, now: number, inner: number, g: Glyphs, stampTable: Elements['terminal'] | null, press: Press, coarse: boolean, pr: Pricing): El {
  const { Box, Text, Button } = t
  const status = groupStatus(group)
  const running = status === 'running'
  const mid = motionId(group)
  const dot = g.dot[status]
  if (stampTable && running) motionState.dots.push(mid)
  const rest = fit(groupLabel(group), Math.max(1, inner - (Array.from(dot).length + 1)))
  const f = groupFigures(group, now, pr)

  const stamp = groupStamp(ui, group, now)
  let line2: El
  if (stamp) {
    if (stampTable) {
      const Raster = stampTable.Raster
      motionState.stamps[mid] = { kind: stamp.kind, startedAt: now - stamp.progress * STAMP_MS }
      line2 = <Raster {...raster(stampRaster(mid, stamp.kind, stamp.progress))} />
    } else {
      line2 = (
        <Text bold color={hexOf(stamp.kind)}>
          {STAMP_TEXT[stamp.kind]}
        </Text>
      )
    }
  } else {
    line2 = countsLine(t, f, inner)
  }

  // the terminal counts up while a ticker runs: a running run with one contributes the ticker's value instead of its ledger value
  let tokens = f.tokens
  let cost = f.cost
  if (stampTable) {
    for (const run of group.runs) {
      if (run.status !== 'running' || !Object.hasOwn(motionState.tickers, run.id)) continue
      const tick = motionState.tickers[run.id]
      if (!tick || now - tick.startedAt >= TICK_MS) continue
      const live = tickerValue(tick, now)
      tokens = (tokens ?? 0) + live.tokens - (totalTokens(run.usage) ?? 0)
      const shown = shownCost(run, pr.mode, pr.table, pr.fetched)
      if (shown.cost !== null && cost !== null) cost += live.cost - shown.cost
    }
  }
  const figures = [
    (coarse && running ? fmtElapsedCoarse : fmtDuration)(f.elapsedMs),
    tokens === null ? '—' : `${f.approx ? '≈' : ''}${fmtTokens(tokens)} tok`,
    cost === null ? (f.costPartial ? '?' : '—') : fmtCost(cost, f.costSource, f.costPartial),
  ]
  const whole = figures.join('   ')
  const lines = Array.from(whole).length <= inner ? [whole] : packFigures(figures, inner)
  return (
    <Box key={`card-${group.id}`} flexDirection="column">
      <Box>
        {stampTable && running ? (
          <Box>
            <stampTable.Raster {...raster(dotRaster(mid, g.on, dotFrame(now).color))} />
            <Text>{' '}</Text>
          </Box>
        ) : (
          <Text color={statusColor(status)} bold={running}>{`${dot} `}</Text>
        )}
        <Button key={group.id} plain label={rest} onPress={() => press({ view: 'dossier', dossierId: group.id })} />
      </Box>
      {line2}
      <Text dimColor>{lines.join('\n')}</Text>
    </Box>
  )
}

/** HQ, the main loop, as the first card: a fixed dot, no status words (it has no end), its own figures; null before it has any tokens. */
function hqCard(t: Table, ledger: Ledger, now: number, inner: number, g: Glyphs, press: Press, coarse: boolean, pr: Pricing): El | null {
  const tokens = totalTokens(ledger.hq.usage) ?? 0
  if (tokens === 0) return null
  const { Box, Text, Button } = t
  const shown = shownHq(ledger, pr.mode, pr.table, pr.fetched)
  const rest = fit(`HQ  claude-code · ${hqModelOf(ledger) ?? '—'} · ${ledger.hqEffort ?? '—'}`, Math.max(1, inner - (Array.from(g.on).length + 1)))
  const figures = [(coarse ? fmtElapsedCoarse : fmtDuration)(now - ledger.sessionStartedAt), `${fmtTokens(tokens)} tok`, fmtCost(shown.cost, shown.source, shown.partial === true)]
  const whole = figures.join('   ')
  const lines = Array.from(whole).length <= inner ? [whole] : packFigures(figures, inner)
  return (
    <Box key="card-hq" flexDirection="column">
      <Box>
        <Text color={PALETTE.accent}>{`${g.on} `}</Text>
        <Button key="hq" plain label={rest} onPress={() => press({ view: 'dossier', dossierId: 'hq' })} />
      </Box>
      <Text dimColor>{lines.join('\n')}</Text>
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
  const groups = groupsOf(ledger)
  const signalTokens = totalTokens(tot.usage) ?? 0
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
  const hq = hqCard(t, ledger, now, inner, g, press, lay.coarse, lay.pricing)
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
      {kv('tokens', fmtTokens(signalTokens), PALETTE.accent)}
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
      {lay.showOverhead && blank}
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
      {hq !== null && <Box flexDirection="column" marginBottom={groups.length === 0 ? 0 : 1}>{hq}</Box>}
      {groups.length === 0 && hq === null && <Text dimColor>No operatives yet — the flock is watching.</Text>}
      {groups.map((group, i) => (
        <Box flexDirection="column" key={'card:' + group.id} marginBottom={i === groups.length - 1 ? 0 : 1}>
          {groupCard(t, group, ui, now, inner, g, lay.stampTable, press, lay.coarse, lay.pricing)}
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
      const id = ui.dossierId
      if (id === 'hq') {
        body = hqDossierView(t, ledger, now, lay.inner, press, pr)
      } else if (id !== undefined && id.startsWith(GROUP_PREFIX)) {
        body = groupDossierView(t, groupsOf(ledger).find(group => group.id === id), ledger, now, lay.inner, g, press, pr)
      } else {
        const run = id !== undefined && Object.hasOwn(ledger.runs, id) ? ledger.runs[id] : undefined
        body = dossierView(t, run, ledger, now, lay.inner, g, press, pr)
      }
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
