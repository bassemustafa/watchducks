import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

import type { UiState } from '../types'
import { INITIAL_UI } from '../src/state'

const RELAY_CALL = { tool: 'Bash', tool_use_id: 'u1', run_in_background: true, command: 'node x/opencode-delegate/scripts/relay.mjs --lane debate --out-dir /tmp/o1' }

// The test's `$` has no `state` noun: an observer beneath the plugin sees every ui value the plugin writes.
function watchUi(on: On): () => UiState {
  let latest: UiState = INITIAL_UI
  on('state.set', { plugin: 'watchducks', key: 'ui' }, async ($, e, next) => {
    latest = e.value as UiState
    return next(e)
  })
  return () => latest
}

// A pane of the plugin, mounted as the engine draws it for a surface and a width.
function pane($: Engine, surface: 'terminal' | 'desktop', columns: number) {
  return $.ui.mount({
    plugin: 'watchducks',
    surface,
    component: 'Pane',
    requestId: 'flock',
    props: { title: 'The Flock', isFocused: false, bodyColumns: columns, placement: 'dock' } as never,
    viewport: { columns: columns + 4, rows: 40, isFullscreen: true },
  })
}

function band($: Engine) {
  return $.ui.mount({
    plugin: 'watchducks',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 60 } as never,
    viewport: { columns: 64, rows: 40, isFullscreen: true },
  })
}

async function drawn(m: { drawn: () => Promise<unknown> }): Promise<string> {
  return JSON.stringify(await m.drawn())
}

// One draw of the pane, unmounted after, so a test can draw the same pane again.
async function view($: Engine, surface: 'terminal' | 'desktop', columns: number): Promise<string> {
  const m = await pane($, surface, columns)
  try {
    return await drawn(m)
  } finally {
    await m.unmount()
  }
}

function backgroundRelay(on: On): void {
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { backgroundTaskId: 't1' } }) as never)
}

test('empty state says the flock is watching', async ($, on) => {
  mock.clock(on)
  const ui = await pane($, 'terminal', 40)
  expect(await drawn(ui)).toContain('No operatives yet — the flock is watching.')
})

test('one running relay shows its codename and IN FIELD', async ($, on) => {
  backgroundRelay(on)
  await $.tool.call(RELAY_CALL as never)
  const ui = await pane($, 'terminal', 40)
  const text = await drawn(ui)
  expect(text).toMatch(/[A-Z]+-[0-9A-Z]{2}/)
  expect(text).toContain('IN FIELD')
})

test('pressing a card opens the dossier, which has a Back button', async ($, on) => {
  const state = watchUi(on)
  backgroundRelay(on)
  await $.tool.call(RELAY_CALL as never)
  const ui = await pane($, 'terminal', 40)
  await ui.press({ key: 'bash:u1' })
  expect(state().view).toBe('dossier')
  expect(state().dossierId).toBe('bash:u1')
  expect(await drawn(ui)).toContain('Back')
})

test('the back button returns from the dossier to the field', async ($, on) => {
  const state = watchUi(on)
  backgroundRelay(on)
  await $.tool.call(RELAY_CALL as never)
  const ui = await pane($, 'terminal', 40)
  await ui.press({ key: 'bash:u1' })
  await ui.press({ key: 'back' })
  expect(state().view).toBe('field')
})

test('station toggle: the station button opens the board, the span button switches to 30 days', async ($, on) => {
  const state = watchUi(on)
  mock.store(on)
  const ui = await pane($, 'terminal', 40)
  await ui.press({ key: 'station' })
  expect(state().view).toBe('station')
  await ui.press({ key: 'span' })
  expect(state().span).toBe('30d')
  const text = await drawn(ui)
  expect(text).toContain('Session')
  expect(text).toContain('30 days')
})

test('the band shows while the pane is not placed and hides once it is placed', async ($, on) => {
  let isPlaced = false
  // the engine draws nothing in the band when the plugin hands it on
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e) as unknown as { Text: (props: { children: string }) => never }
    return Text({ children: '' })
  })
  on('ui.panes', async () => ({ value: [{ id: 'flock', title: 'The Flock', isShown: true, isFocused: false, isPlaced }] }))
  backgroundRelay(on)
  await $.tool.call(RELAY_CALL as never)
  expect(await drawn(await band($))).toContain('FLOCK')
  isPlaced = true
  expect(await drawn(await band($))).not.toContain('FLOCK')
})

test('terminal has the radar Raster at 40 columns and none at 30', async ($) => {
  const wide = await pane($, 'terminal', 40)
  expect(await drawn(wide)).toContain('"key":"radar"')
  await wide.unmount()
  expect(await drawn(await pane($, 'terminal', 30))).not.toContain('"key":"radar"')
})

test('desktop has the Svg and no Raster', async ($) => {
  const text = await drawn(await pane($, 'desktop', 40))
  expect(text).toContain('Svg')
  expect(text).not.toContain('Raster')
})

test('/flock purge removes every stored history key', async ($, on) => {
  // the test's `$` has no `store` noun: the store is seeded through the mock and checked by what a second purge finds
  mock.store(on, {
    'history/v1/old-1': { v: 1, sessionStartedAt: 0, days: {} },
    'history/v1/old-2': { v: 1, sessionStartedAt: 0, days: {} },
    other: 1,
  })
  const answer = await $.command.run({ command: 'flock', args: 'purge' } as never)
  expect(JSON.stringify(answer)).toContain('2 records')
  const again = await $.command.run({ command: 'flock', args: 'purge' } as never)
  expect(JSON.stringify(again)).toContain('0 records')
})

test('a run that turns done is stamped for 1.5 s and the stamp then clears', async ($, on) => {
  const state = watchUi(on)
  on('command.register', async () => ({ value: { command: 'flock' } }))
  on('session.id', async () => ({ value: 'S1' }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('turn.complete', async () => ({ text: '' }))
  on('ui.panes', async () => ({ value: [] }))
  mock.store(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/work', surface: null, isInteractive: true })
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  await clock.advance(600)
  await $.turn.complete({ agentId: 'a1', turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false } as never)
  await clock.advance(600)
  expect(state().stamps?.['a1']?.kind).toBe('done')
  await clock.advance(1600)
  expect(state().stamps).toBeUndefined()
})

// Two agents that end in the same watch tick: a1 answers, a2 errors.
async function endTwo(on: On, ui: Engine) {
  let n = 0
  on('command.register', async () => ({ value: { command: 'flock' } }))
  on('session.id', async () => ({ value: 'S1' }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: `a${++n}` }))
  on('turn.complete', async () => ({ text: '' }))
  on('ui.panes', async () => ({ value: [] }))
  mock.store(on)
  const clock = mock.clock(on)
  await ui.session.start({ cwd: '/work', surface: null, isInteractive: true })
  await ui.agent.spawn({ subagentType: 'Explore' } as never)
  await ui.agent.spawn({ subagentType: 'Explore' } as never)
  await clock.advance(100)
  await ui.turn.complete({ agentId: 'a1', turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false } as never)
  await ui.turn.complete({ agentId: 'a2', turnId: 't2', reason: 'error', answer: '', durationMs: 1, isAborted: false } as never)
  await clock.advance(600)
  return clock
}

test('two runs ending in one tick each get a raster stamp on the terminal', async ($, on) => {
  await endTwo(on, $)
  const text = await view($, 'terminal', 52)
  expect(text).toContain('"key":"stamp:a1"')
  expect(text).toContain('"key":"stamp:a2"')
})

test('two runs ending in one tick each show a stamp text on the desktop; a failed run reads WENT DARK', async ($, on) => {
  await endTwo(on, $)
  const text = await view($, 'desktop', 52)
  expect(text).toContain('✦ DEBRIEFED ✦')
  expect(text).toContain('✕ WENT DARK ✕')
  expect(text).not.toContain('Raster')
})

test('both stamps are gone once STAMP_MS has passed', async ($, on) => {
  const clock = await endTwo(on, $)
  await clock.advance(1600)
  const text = await view($, 'terminal', 52)
  expect(text).not.toContain('stamp:')
})

test('motion off draws the stamp as Text, not a stamp raster', { options: { motion: 'off' } }, async ($, on) => {
  await endTwo(on, $)
  const text = await view($, 'terminal', 52)
  expect(text).not.toContain('stamp:')
  expect(text).toContain('✦ DEBRIEFED ✦')
  expect(text).toContain('✕ WENT DARK ✕')
})

// ---- batch B: review findings

const BIG_USAGE = { model: 'claude-sonnet-5-5', input_tokens: 200000, output_tokens: 20000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// A running subagent whose first step carried usage: 220k tokens, $0.60 estimated.
function runningAgent(on: On): void {
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: BIG_USAGE } as never
  })
}

async function stepAgent($: Engine): Promise<void> {
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  for await (const _ of $.turn.step({ agentId: 'a1', turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'high' } as never)) {
    /* chunks are never read */
  }
}

test('F14: a raw codex CLI row on the station board shows dashes, never zero tokens or $0', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, async () => ({ result: {} }) as never)
  mock.store(on)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c1', command: 'codex exec -m gpt-6.1-sol "x"' } as never)
  const ui = await pane($, 'terminal', 52)
  await ui.press({ key: 'station' })
  const text = await drawn(ui)
  expect(text).toContain('codex · gpt-6.1-sol')
  // tokens are the dash padded to the five-wide column, cost is the bare dash
  expect(text).toContain('"   ' + '—'.padStart(5) + '"')
  expect(text).toContain('"—"')
  expect(text).not.toContain('$0')
  // neither cost nor tokens: an empty proportional bar
  expect(text).not.toContain('█')
})

// The render reads Date.now(), which the mock clock does not move: the aging itself is
// pinned by the seriesWindow unit tests; this checks the sidebar draws this minute's activity.
test('F15: the sparkline shows the current minute of activity', async ($, on) => {
  runningAgent(on)
  await stepAgent($)
  const braille = (tree: string) => tree.match(/\p{Script=Braille}+/gu)?.join('') ?? ''
  const fresh = braille(await view($, 'terminal', 52))
  // the newest minute is the right dot column of the last glyph, full height
  expect(fresh).toContain(String.fromCodePoint(0x28f8))
})

test('F16: no Raster and no Svg at 30 columns, on either surface', async ($) => {
  const terminal = await view($, 'terminal', 30)
  expect(terminal).not.toContain('Raster')
  expect(terminal).not.toContain('"key":"cache"')
  expect(terminal).not.toContain('"key":"radar"')
  expect(terminal).toContain('cache —')
  const desktop = await view($, 'desktop', 30)
  expect(desktop).not.toContain('Svg')
  expect(desktop).not.toContain('Raster')
  expect(desktop).toContain('cache —')
})

test('F16: the compact tier writes the cache share and the spend as text', async ($, on) => {
  runningAgent(on)
  await stepAgent($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const text = await view($, surface, 30)
    expect(text).toContain('cache 0%')
    expect(text).toMatch(/spend [a-z-]+ \$0\.60/)
  }
})

// Every object in the drawn tree that carries an <svg> source: the props of one Svg element.
function svgProps(text: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (v === null || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    if (typeof o.source === 'string' && o.source.startsWith('<svg')) found.push(o)
    Object.values(o).forEach(walk)
  }
  walk(JSON.parse(text))
  return found
}

test('every desktop Svg has a height matching its markup and none is interactive', async ($, on) => {
  runningAgent(on)
  await stepAgent($)
  const svgs = svgProps(await view($, 'desktop', 52))
  expect(svgs.length).toBe(3)
  for (const p of svgs) {
    expect(typeof p.height).toBe('number')
    expect(p.source).toContain(`width="${p.width}" height="${p.height}"`)
  }
  // every desktop Svg is an image: an interactive frame flashes on each redraw
  expect(svgs.filter(p => p.isInteractive).length).toBe(0)
  expect(svgs.some(p => String(p.source).includes('THE FLOCK'))).toBe(true)
})

test('a running card reads <1m on the desktop and 0:SS on the terminal', async ($, on) => {
  runningAgent(on)
  await stepAgent($)
  const desktop = await view($, 'desktop', 52)
  expect(desktop).toContain('<1m')
  expect(desktop).not.toMatch(/0:\d\d/)
  expect(await view($, 'terminal', 52)).toMatch(/0:\d\d/)
})

test('F16: at 40 columns the terminal keeps the cache bar and the desktop header loses the duck', async ($) => {
  expect(await view($, 'terminal', 40)).toContain('"key":"cache"')
  const mid = await view($, 'desktop', 40)
  expect(mid).toContain('Svg')
  expect(mid).not.toContain('wd-duck')
  const full = await view($, 'desktop', 52)
  expect(full).toContain('wd-duck')
})

test('F17: a running card keeps its token count and cost source at 30 and 48 columns', async ($, on) => {
  runningAgent(on)
  await stepAgent($)
  for (const columns of [30, 48]) {
    const text = await view($, 'terminal', columns)
    expect(text).toContain('220k tok')
    expect(text).toContain('$0.60 est.')
  }
})

test('F18: the band stays when the pane is placed but its tab is not shown', async ($, on) => {
  let isShown = false
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e) as unknown as { Text: (props: { children: string }) => never }
    return Text({ children: '' })
  })
  on('ui.panes', async () => ({ value: [{ id: 'flock', title: 'The Flock', isShown, isFocused: false, isPlaced: true }] }))
  backgroundRelay(on)
  await $.tool.call(RELAY_CALL as never)
  expect(await drawn(await band($))).toContain('FLOCK')
  isShown = true
  expect(await drawn(await band($))).not.toContain('FLOCK')
})

test('F19: the dossier values use the terminal text color', async ($, on) => {
  backgroundRelay(on)
  await $.tool.call(RELAY_CALL as never)
  const ui = await pane($, 'terminal', 52)
  await ui.press({ key: 'bash:u1' })
  const text = await drawn(ui)
  expect(text).toContain('implementer')
  expect(text).not.toContain('#e2e8f0')
})

test('F14: an unpriced model row shows ? for its cost, not a dash', async ($, on) => {
  mock.store(on)
  on('agent.spawn', async () => ({ model: 'mystery-model-1', agentId: 'a1' }))
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...BIG_USAGE, model: 'mystery-model-1' } } as never
  })
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  for await (const _ of $.turn.step({ agentId: 'a1', turnId: 't1', index: 0, model: 'mystery-model-1' } as never)) {
    /* chunks are never read */
  }
  const ui = await pane($, 'terminal', 52)
  await ui.press({ key: 'station' })
  const text = await drawn(ui)
  expect(text).toContain('mystery-model-1')
  expect(text).toContain('"?"')
})

// ---- token breakdown, desktop station bar, finished desktop card

test('the dossier lists input as the sum of its parts, then output and the total', async ($, on) => {
  mock.store(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('turn.step', async function* () {
    const usage = { ...BIG_USAGE, input_tokens: 100000, cache_read_input_tokens: 60000, cache_creation_input_tokens: 40000 }
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  await stepAgent($)
  const ui = await pane($, 'terminal', 52)
  await ui.press({ key: 'a1' })
  const text = await drawn(ui)
  // 100k + 60k + 40k input, 20k output
  expect(text).toMatch(/"input\s+"[^]*"200k"/)
  expect(text).toMatch(/"  cache write\s*"/)
  expect(text).toMatch(/"total\s+"[^]*"220k"/)
})

test('the station board splits a measured row into input and output, and dashes an unmeasured one', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, async () => ({ result: {} }) as never)
  mock.store(on)
  runningAgent(on)
  await stepAgent($)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c1', command: 'codex exec -m gpt-6.1-sol "x"' } as never)
  const ui = await pane($, 'terminal', 52)
  await ui.press({ key: 'station' })
  const text = await drawn(ui)
  expect(text).toContain('"in  "')
  expect(text).toContain('"   out "')
  expect(text).toContain('"  uncached "')
  expect(text).toContain('" · read "')
  expect(text).toContain('" · write "')
  // the codex CLI row has no measured usage: its in/out line is dashes and it has no breakdown line
  expect(text.match(/"  uncached "/g)?.length).toBe(1)
  expect(text.match(/"in  "/g)?.length).toBe(2)
})

test('the desktop station board draws the row bar as a plain Svg, the terminal keeps the text bar', async ($, on) => {
  mock.store(on)
  runningAgent(on)
  await stepAgent($)
  const desktop = await pane($, 'desktop', 52)
  await desktop.press({ key: 'station' })
  const dText = await drawn(desktop)
  await desktop.unmount()
  const bars = svgProps(dText)
  expect(bars.length).toBe(1)
  expect(typeof bars[0]?.height).toBe('number')
  expect(bars[0]?.isInteractive).toBeUndefined()
  expect(dText).not.toContain('█')
  const terminal = await pane($, 'terminal', 52)
  await terminal.press({ key: 'station' })
  const tText = await drawn(terminal)
  expect(tText).toContain('█')
  expect(svgProps(tText).length).toBe(0)
})

test('a finished card on the desktop shows its exact M:SS duration', async ($, on) => {
  on('command.register', async () => ({ value: { command: 'flock' } }))
  on('session.id', async () => ({ value: 'S1' }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('turn.complete', async () => ({ text: '' }))
  on('ui.panes', async () => ({ value: [] }))
  mock.store(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/work', surface: null, isInteractive: true })
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  await $.turn.complete({ agentId: 'a1', turnId: 't1', reason: 'answer', answer: '', durationMs: 49000, isAborted: false } as never)
  await clock.advance(2000)
  const desktop = await view($, 'desktop', 52)
  expect(desktop).toMatch(/0:\d\d/)
  expect(desktop).not.toContain('<1m')
})

test('a running card draws its dot as a Raster on the terminal and as Text on the desktop', async ($, on) => {
  on('ui.panes', async () => ({ value: [] }))
  backgroundRelay(on)
  await $.tool.call(RELAY_CALL as never)
  expect(await view($, 'terminal', 52)).toMatch(/"key":"dot:[^"]+"/)
  expect(await view($, 'desktop', 52)).not.toContain('"key":"dot:')
})

test('motion off keeps the running dot as Text', { options: { motion: 'off' } }, async ($, on) => {
  on('ui.panes', async () => ({ value: [] }))
  backgroundRelay(on)
  await $.tool.call(RELAY_CALL as never)
  expect(await view($, 'terminal', 52)).not.toContain('"key":"dot:')
})

function spin(ms: number): void {
  const end = Date.now() + ms
  for (let i = 0; i < 5e7 && Date.now() < end; i++) {
    // wait
  }
}

// A running agent whose second step adds 10k tokens; the watch tick that sees it starts the count-up.
async function tickedWorld($: Engine, on: On) {
  on('command.register', async () => ({ value: { command: 'flock' } }))
  on('session.id', async () => ({ value: 'S1' }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('turn.complete', async () => ({ text: '' }))
  on('ui.panes', async () => ({ value: [] }))
  let steps = 0
  on('turn.step', async function* ($, e) {
    // each answer names the step it answers; a repeated (turn, index) would be dropped as a replay
    const input = steps++ === 0 ? 200000 : 10000
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...BIG_USAGE, input_tokens: input, output_tokens: steps === 1 ? 20000 : 0 } } as never
  })
  mock.store(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/work', surface: null, isInteractive: true })
  await stepAgent($)
  await clock.advance(600) // the first watch tick records 220k
  for await (const _ of $.turn.step({ agentId: 'a1', turnId: 't1', index: 1, model: 'claude-sonnet-5-5', effort: 'high' } as never)) {
    /* chunks are never read */
  }
  await clock.advance(600) // the next one sees 230k and starts the count-up
  return clock
}

test('the terminal card counts up to a new token total and settles on it', async ($, on) => {
  await tickedWorld($, on)
  spin(200)
  const mid = await view($, 'terminal', 52)
  expect(mid).toMatch(/22[1-9]k tok/)
  expect(mid).not.toContain('230k tok')
  spin(500)
  const done = await view($, 'terminal', 52)
  expect(done).toContain('230k tok')
})

test('the desktop card shows the final token total at once', async ($, on) => {
  await tickedWorld($, on)
  const text = await view($, 'desktop', 52)
  expect(text).toContain('230k tok')
  expect(text).not.toMatch(/22[1-9]k tok/)
})
