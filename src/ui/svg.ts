import type { RunStatus } from '../../types'
import { DEFAULT_COLOR, duckPixels, hex, mix } from './raster'
import { LIGHT, PALETTE, statusColor } from './theme'

// Desktop vector art (spec §9.4): the sidebar header and the stacked spend bar.
// Plain SVG + CSS + SMIL, no scripts and no event-handler attributes; the
// light scheme rides on a prefers-color-scheme media query inside the markup.

const MAX_BLIPS = 64
const MAX_SEGMENTS = 64

const FONT_SANS = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif'
const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

function clampInt(n: number, lo: number, hi: number): number {
  const v = Number.isFinite(n) ? Math.round(n) : lo
  return Math.min(hi, Math.max(lo, v))
}

/** Up to 2 decimals, no trailing zeros, never "-0". */
function n(x: number): string {
  const r = Math.round(x * 100) / 100
  return String(Object.is(r, -0) ? 0 : r)
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function toHex(color: number): string {
  return '#' + (color & 0xffffff).toString(16).padStart(6, '0')
}

/** A color from the caller, as #rrggbb; anything that is not a hex color becomes slate. */
function safeColor(color: string): string {
  const c = hex(color)
  return toHex(c === DEFAULT_COLOR ? 0x64748b : c)
}

function pt(cx: number, cy: number, r: number, angle: number): string {
  return `${n(cx + r * Math.cos(angle))} ${n(cy + r * Math.sin(angle))}`
}

// One pixel-art row of the duck as merged horizontal runs of <rect>.
function duckRects(x0: number, y0: number, p: number): string {
  let out = ''
  const px = duckPixels()
  for (let y = 0; y < px.length; y++) {
    const row = px[y]!
    let x = 0
    while (x < row.length) {
      const color = row[x] ?? null
      let end = x + 1
      while (end < row.length && (row[end] ?? null) === color) end++
      if (color !== null) {
        out += `<rect x="${n(x0 + x * p)}" y="${n(y0 + y * p)}" width="${(end - x) * p}" height="${p}" fill="${toHex(color)}"/>`
      }
      x = end
    }
  }
  return out
}

// The sweep: a fan of wedges fading behind a glowing leading edge that lies
// along +x (angle 0 = east, clockwise), to be rotated as a group.
function sweepShapes(cx: number, cy: number, r: number): string {
  const slices = 6
  const span = (Math.PI / 180) * 10
  let out = ''
  for (let k = slices; k >= 1; k--) {
    const a1 = -k * span
    const a2 = -(k - 1) * span
    const opacity = 0.34 * (1 - (k - 1) / slices) ** 1.6
    out += `<path class="sw" d="M${n(cx)} ${n(cy)}L${pt(cx, cy, r, a1)}A${n(r)} ${n(r)} 0 0 1 ${pt(cx, cy, r, a2)}Z" fill="${PALETTE.accent}" fill-opacity="${n(opacity)}"/>`
  }
  out += `<line x1="${n(cx)}" y1="${n(cy)}" x2="${n(cx + r)}" y2="${n(cy)}" stroke="url(#wd-lead)" stroke-width="1.8" stroke-linecap="round" filter="url(#wd-glow)"/>`
  return out
}

function blipShapes(
  blips: ReadonlyArray<{ angle: number; radius: number; status: RunStatus }>,
  cx: number,
  cy: number,
  reach: number,
  motion: boolean,
): string {
  let halos = ''
  let cores = ''
  blips.slice(0, MAX_BLIPS).forEach((b, i) => {
    const a = Number.isFinite(b.angle) ? b.angle : 0
    const r = Math.min(1, Math.max(0, Number.isFinite(b.radius) ? b.radius : 0))
    const x = cx + Math.cos(a) * r * reach
    const y = cy + Math.sin(a) * r * reach
    const color = statusColor(b.status)
    const live = motion && b.status === 'running'
    const begin = `${n((i % 8) * 0.25)}s`
    halos += `<circle cx="${n(x)}" cy="${n(y)}" r="6.5" fill="${color}"/>`
    let core = `<circle cx="${n(x)}" cy="${n(y)}" r="3" fill="${color}" stroke="${PALETTE.bg}" stroke-opacity=".55" stroke-width=".8"`
    if (live) {
      core += `><animate attributeName="opacity" values="1;.45;1" dur="1.6s" begin="${begin}" repeatCount="indefinite"/></circle>`
      core += `<circle cx="${n(x)}" cy="${n(y)}" r="3" fill="none" stroke="${color}" stroke-width="1"><animate attributeName="r" values="3;10" dur="2s" begin="${begin}" repeatCount="indefinite"/><animate attributeName="opacity" values=".7;0" dur="2s" begin="${begin}" repeatCount="indefinite"/></circle>`
    } else {
      core += '/>'
    }
    cores += core
  })
  return `<g filter="url(#wd-glow)" opacity=".55">${halos}</g>${cores}`
}

export function headerSvg(opts: {
  blips: ReadonlyArray<{ angle: number; radius: number; status: RunStatus }>
  motion: boolean
  width: number
  /** The duck beside the title; default true. The mid width tier leaves it out. */
  logo?: boolean
}): string {
  const W = clampInt(opts.width, 280, 1200)
  const H = Math.max(80, Math.round(W * 0.28))
  const pad = Math.round(H * 0.12)
  const p = Math.max(2, Math.floor((H - 2 * pad) / 12))
  const duckSize = p * 12
  const duckX = pad
  const duckY = Math.round((H - duckSize) / 2)
  const R = (H - 2 * pad) / 2 - 2
  const cx = W - pad - R - 2
  const cy = H / 2

  const running = opts.blips.filter(b => b.status === 'running').length
  const total = opts.blips.length

  const logo = opts.logo !== false
  const textX = logo ? duckX + duckSize + pad : pad
  const fs = Math.round(H * 0.17)
  const naturalTitle = 9 * fs * 0.8
  const room = cx - R - textX - pad * 0.6
  const fit = room < naturalTitle ? ` textLength="${n(Math.max(40, room))}" lengthAdjust="spacingAndGlyphs"` : ''
  const blockHeight = fs + 8 + 3 + 8 + 11
  const top = cy - blockHeight / 2
  const titleY = top + fs * 0.85
  const barY = top + fs + 8
  const subY = barY + 3 + 8 + 9

  const sub = total === 0
    ? `<text class="dm" x="${n(textX)}" y="${n(subY)}" font-family="${FONT_MONO}" font-size="11" fill="${PALETTE.dim}">STANDING BY</text>`
    : `<text x="${n(textX)}" y="${n(subY)}" font-family="${FONT_MONO}" font-size="11"><tspan class="ac" fill="${PALETTE.accent}">${running} IN FIELD</tspan><tspan class="dm" fill="${PALETTE.dim}"> · ${total} TRACKED</tspan></text>`

  const sweep = opts.motion
    ? `<g><animateTransform attributeName="transform" type="rotate" from="0 ${n(cx)} ${n(cy)}" to="360 ${n(cx)} ${n(cy)}" dur="4s" repeatCount="indefinite"/>${sweepShapes(cx, cy, R)}</g>`
    : `<g transform="rotate(-35 ${n(cx)} ${n(cy)})">${sweepShapes(cx, cy, R)}</g>`

  const s: string[] = []
  s.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">`)
  s.push(
    '<defs>',
    `<linearGradient id="wd-panel" x1="0" y1="0" x2="1" y2="1"><stop class="g0" offset="0" stop-color="${PALETTE.panel}"/><stop class="g1" offset="1" stop-color="${PALETTE.bg}"/></linearGradient>`,
    '<linearGradient id="wd-edge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".18"/><stop offset="1" stop-color="#fff" stop-opacity=".02"/></linearGradient>',
    `<linearGradient id="wd-lead" gradientUnits="userSpaceOnUse" x1="${n(cx)}" y1="0" x2="${n(cx + R)}" y2="0"><stop class="ls" offset="0" stop-color="${PALETTE.accent}" stop-opacity="0"/><stop class="ls" offset="1" stop-color="#99f6e4"/></linearGradient>`,
    `<linearGradient id="wd-rule" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${PALETTE.accent}"/><stop offset="1" stop-color="${PALETTE.done}"/></linearGradient>`,
    `<radialGradient id="wd-glowbg"><stop offset="0" stop-color="${PALETTE.accent}" stop-opacity=".22"/><stop offset="1" stop-color="${PALETTE.accent}" stop-opacity="0"/></radialGradient>`,
    '<filter id="wd-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>',
    `<style>@media (prefers-color-scheme: light){.g0{stop-color:${LIGHT.bg}}.g1{stop-color:${LIGHT.panel}}.tx{fill:${LIGHT.text}}.dm{fill:${LIGHT.dim}}.ac{fill:#0d9488}.sw{fill:#0d9488}.ls{stop-color:#0d9488}.disc{fill:${LIGHT.bg}}}</style>`,
    '</defs>',
  )
  s.push(`<rect width="${W}" height="${H}" rx="14" fill="url(#wd-panel)"/>`)
  s.push(`<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="13.5" fill="none" stroke="url(#wd-edge)"/>`)
  // Duck, on a soft teal glow.
  if (logo) {
    s.push(
      `<g id="wd-duck"><ellipse cx="${n(duckX + duckSize / 2)}" cy="${n(duckY + duckSize / 2)}" rx="${n(duckSize * 0.8)}" ry="${n(duckSize * 0.7)}" fill="url(#wd-glowbg)"/>`,
      `<g shape-rendering="crispEdges">${duckRects(duckX, duckY, p)}</g></g>`,
    )
  }
  // Title block.
  s.push(`<text class="tx" x="${n(textX)}" y="${n(titleY)}" font-family="${FONT_SANS}" font-size="${fs}" font-weight="700" letter-spacing="2" fill="${PALETTE.text}"${fit}>THE FLOCK</text>`)
  s.push(`<rect x="${n(textX)}" y="${n(barY)}" width="34" height="3" rx="1.5" fill="url(#wd-rule)"/>`)
  s.push(sub)
  // Radar.
  s.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R * 1.35)}" fill="url(#wd-glowbg)" opacity=".5"/>`)
  s.push(`<circle class="disc" cx="${n(cx)}" cy="${n(cy)}" r="${n(R)}" fill="${PALETTE.bg}" fill-opacity=".6"/>`)
  s.push(
    `<g fill="none" stroke="${PALETTE.ended}" stroke-opacity=".5" stroke-width=".8">`,
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R / 3)}" stroke-dasharray="2 3"/>`,
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n((R * 2) / 3)}" stroke-dasharray="2 3"/>`,
    `<path d="M${n(cx - R)} ${n(cy)}H${n(cx + R)}M${n(cx)} ${n(cy - R)}V${n(cy + R)}" stroke-dasharray="1 4"/>`,
    '</g>',
  )
  s.push(sweep)
  s.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R)}" fill="none" stroke="${PALETTE.ended}" stroke-opacity=".8" stroke-width="1.2"/>`)
  s.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="1.8" fill="${PALETTE.accent}"/>`)
  s.push(blipShapes(opts.blips, cx, cy, R - 5, opts.motion))
  s.push('</svg>')
  return s.join('')
}

function fmtValue(v: number): string {
  return String(Number(v.toFixed(4)))
}

/** A stacked, pill-shaped bar; each segment has a <title> tooltip with its exact number and share. */
export function barSvg(segments: ReadonlyArray<{ label: string; value: number; color: string }>, width: number): string {
  const W = clampInt(width, 40, 1200)
  const H = 14
  const used = segments.filter(seg => Number.isFinite(seg.value) && seg.value > 0).slice(0, MAX_SEGMENTS)
  const total = used.reduce((sum, seg) => sum + seg.value, 0)

  const defs: string[] = [`<clipPath id="wd-bar-clip"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath>`]
  const bars: string[] = []
  let x = 0
  used.forEach((seg, i) => {
    const color = safeColor(seg.color)
    const w = i === used.length - 1 ? W - x : (seg.value / total) * W
    const gap = i === 0 ? 0 : 0.75
    const tail = i === used.length - 1 ? 0 : 0.75
    const share = Math.round((seg.value / total) * 100)
    const tip = `${esc(seg.label)}: ${fmtValue(seg.value)} (${share < 1 ? '&lt;1' : share}%)`
    defs.push(`<linearGradient id="wd-seg${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${toHex(mix(hex(color), 0xffffff, 0.3))}"/><stop offset="1" stop-color="${color}"/></linearGradient>`)
    bars.push(`<g><title>${tip}</title><rect x="${n(x + gap)}" y="0" width="${n(Math.max(0.5, w - gap - tail))}" height="${H}" fill="url(#wd-seg${i})"/></g>`)
    x += w
  })

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">`,
    `<defs>${defs.join('')}</defs>`,
    `<rect width="${W}" height="${H}" rx="${H / 2}" fill="${PALETTE.ended}" fill-opacity=".25"/>`,
    `<g clip-path="url(#wd-bar-clip)">${bars.join('')}<rect width="${W}" height="${H / 2}" fill="#fff" fill-opacity=".08"/></g>`,
    '</svg>',
  ].join('')
}
