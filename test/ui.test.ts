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
  expect(state().stamp?.runId).toBe('a1')
  await clock.advance(1600)
  expect(state().stamp).toBeUndefined()
})
