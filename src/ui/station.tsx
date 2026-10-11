import type { StationRow, Usage } from '../../types'
import { fit, type Glyphs, type Press, type Table } from './dossier'
import { cachePct, fmtCost, fmtTokens } from './format'
import { PALETTE } from './theme'

// The station board (spec §9.2 item 5): one entry per implementer × model with
// a proportional bar, built from rows the render hook already computed.

/** Known spend of a row, or null when no op of it carried a cost. */
function rowCost(r: StationRow): number | null {
  return r.costOps > 0 ? r.costReported + r.costEstimated : null
}

function rowUsage(r: StationRow): Usage {
  return { uncached: r.uncached, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite }
}

function rowTokens(r: StationRow): number {
  return r.uncached + r.output + r.cacheRead + r.cacheWrite
}

/** Share of the row inside the board: by cost, or by tokens when no row has a measured cost; a row with neither weighs nothing. */
function weights(rows: readonly StationRow[]): number[] {
  if (rows.some(r => r.costOps > 0)) return rows.map(r => rowCost(r) ?? 0)
  return rows.map(r => (r.usageOps > 0 ? rowTokens(r) : 0))
}

function bar(fraction: number, width: number): { filled: string; empty: string } {
  const n = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return { filled: '█'.repeat(n), empty: '░'.repeat(width - n) }
}

export function stationView(
  t: Table,
  rows: readonly StationRow[],
  span: 'session' | '30d',
  inner: number,
  g: Glyphs,
  press: Press,
): ReturnType<Table['Box']> {
  const { Box, Text, Button } = t
  const w = weights(rows)
  const top = Math.max(...w, 0)

  const mark = (which: 'session' | '30d') => (span === which ? g.on : g.off)
  const toggle = (
    <Button
      key="span"
      hotkey="h"
      plain
      label={`${mark('session')} Session   ${mark('30d')} 30 days`}
      onPress={() => press({ span: span === 'session' ? '30d' : 'session' })}
    />
  )

  return (
    <Box flexDirection="column">
      <Text bold color={PALETTE.accent}>
        STATION BOARD
      </Text>
      <Text> </Text>
      {toggle}
      <Text> </Text>
      {rows.length === 0 && <Text dimColor>Nothing on the board yet.</Text>}
      {rows.map((r, i) => {
        const b = bar(top > 0 ? (w[i] ?? 0) / top : 0, Math.max(8, inner))
        const cost = rowCost(r)
        // no cost at all: "?" when some op should have one (an unpriced model), "—" when none could
        const costText = cost === null ? (r.unknownCostOps > 0 ? '?' : '—') : fmtCost(cost, null, r.unknownCostOps > 0)
        const measured = r.usageOps > 0
        const leaks = r.vetted > 0 ? (r.bugs / r.vetted).toFixed(1) : '—'
        return (
          <Box flexDirection="column" key={`${r.implementer}|${r.model}`} marginBottom={i === rows.length - 1 ? 0 : 1}>
            <Text bold wrap="truncate">
              {fit(`${r.implementer} · ${r.model}`, inner)}
            </Text>
            <Text wrap="truncate">
              <Text color={PALETTE.accent}>{b.filled}</Text>
              <Text color={PALETTE.ended}>{b.empty}</Text>
            </Text>
            <Text wrap="truncate">
              <Text dimColor>ops </Text>
              <Text>{String(r.ops).padStart(3)}</Text>
              <Text color={PALETTE.done}>{`   ${g.dot.done} ${String(r.done).padStart(2)}`}</Text>
              <Text color={PALETTE.failed}>{`   ${g.dot.failed} ${String(r.failed).padStart(2)}`}</Text>
              <Text>{`   ${(measured ? fmtTokens(rowTokens(r)) : '—').padStart(5)}`}</Text>
              <Text dimColor> tok</Text>
            </Text>
            <Text wrap="truncate">
              <Text dimColor>cache </Text>
              <Text>{(measured ? cachePct(rowUsage(r)) : '—').padStart(4)}</Text>
              <Text dimColor>{'   cost '}</Text>
              <Text color={PALETTE.accent}>{costText}</Text>
            </Text>
            <Text wrap="truncate" dimColor>
              {`vetted ${r.vetted}/${r.ops}   ${leaks} leaks per vetted`}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
