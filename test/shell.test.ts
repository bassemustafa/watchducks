import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

import type { Ledger } from '../types'
import { emptyLedger } from '../src/ledger'

const RELAY = 'node x/opencode-delegation/scripts/relay.mjs --lane debate --out-dir /tmp/o1'

// The test's `$` has no `state` noun: an observer beneath the plugin sees every ledger the plugin writes.
function watchLedger(on: On): () => Ledger {
  let latest: Ledger = emptyLedger('', 0)
  on('state.set', { plugin: 'watchducks', key: 'ledger' }, async ($, e, next) => {
    latest = e.value as Ledger
    return next(e)
  })
  return () => latest
}

test('a background relay Bash call starts a running relay run with an out-dir', async ($, on) => {
  const ledger = watchLedger(on)
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { backgroundTaskId: 't1' } }) as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', run_in_background: true, command: RELAY } as never)
  const run = ledger().runs['bash:u1']!
  expect(run.kind).toBe('relay')
  expect(run.status).toBe('running')
  expect(run.outDir).toBe('/tmp/o1')
})

test('a foreground relay Bash call is done when its result arrives', async ($, on) => {
  const ledger = watchLedger(on)
  on('tool.call', { tool: 'Bash' }, async () => ({ result: {} }) as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u2', command: RELAY } as never)
  expect(ledger().runs['bash:u2']!.status).toBe('done')
})

test('a plain foreground npm test creates no run', async ($, on) => {
  const ledger = watchLedger(on)
  on('tool.call', { tool: 'Bash' }, async () => ({ result: {} }) as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u3', command: 'npm test' } as never)
  expect(ledger().runs['bash:u3']).toBeUndefined()
})

test('a plain Bash call that comes back backgrounded becomes a running shell run', async ($, on) => {
  const ledger = watchLedger(on)
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { backgroundTaskId: 't9' } }) as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u4', command: 'npm run watch' } as never)
  const run = ledger().runs['bash:u4']!
  expect(run.kind).toBe('shell')
  expect(run.status).toBe('running')
  expect(run.backgroundTaskId).toBe('t9')
})

test('the Bash result passes through unchanged', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }) as never)
  const answer = await $.tool.call({ tool: 'Bash', tool_use_id: 'u5', command: RELAY } as never)
  expect(answer).toEqual({ result: { stdout: 'ok', stderr: '', interrupted: false } })
})

test('a tracked Bash call whose answer rejects ends killed and the rejection propagates', async ($, on) => {
  const ledger = watchLedger(on)
  const boom = new Error('aborted')
  on('tool.call', { tool: 'Bash' }, async () => {
    throw boom
  })
  let caught: unknown
  try {
    await $.tool.call({ tool: 'Bash', tool_use_id: 'u6', command: RELAY } as never)
  } catch (error) {
    caught = error
  }
  // the engine reports the failed answer as its own error; the call still rejects
  expect(caught instanceof Error).toBe(true)
  expect(ledger().runs['bash:u6']!.status).toBe('killed')
})

// A notification row as the engine raises it for a background task: the full `UserMessage` props.
function notice($: Engine, origin: string, task?: { id?: string; status?: string; toolUseId?: string }) {
  return $.ui.mount({
    plugin: 'watchducks',
    surface: 'terminal',
    component: 'UserMessage',
    props: { text: 'a summary', origin: { kind: origin }, isExpanded: false, ...(task ? { task } : {}) } as never,
    viewport: { columns: 80, rows: 24, isFullscreen: false },
  })
}

const STOPPED = { stop_hook_active: false, background_tasks: [] } as never

// The test's engine draws no row of its own: an empty row beneath the plugin answers `ui.render`.
function drawRows(on: On): void {
  on('ui.render', { component: 'UserMessage' }, async ($, e) => {
    const { Text } = $.ui.resolve(e) as unknown as { Text: (props: { children: string }) => never }
    return Text({ children: '' })
  })
}

test('a background shell that left the snapshot is ended, then done when its notification says completed', async ($, on) => {
  const ledger = watchLedger(on)
  drawRows(on)
  const clock = mock.clock(on)
  on('classic.Stop', async () => ({}))
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { backgroundTaskId: 'tN1' } }) as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'n1', run_in_background: true, command: 'sleep 40' } as never)
  await $.classic.Stop(STOPPED)
  expect(ledger().runs['bash:n1']!.status).toBe('ended')
  await notice($, 'task-notification', { id: 'tN1', status: 'completed' })
  await clock.advance(1)
  expect(ledger().runs['bash:n1']!.status).toBe('done')
})

test('a notification that names only the tool call gives the outcome failed', async ($, on) => {
  const ledger = watchLedger(on)
  drawRows(on)
  const clock = mock.clock(on)
  on('classic.Stop', async () => ({}))
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { backgroundTaskId: 'tN2' } }) as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'n2', run_in_background: true, command: 'sleep 40' } as never)
  await $.classic.Stop(STOPPED)
  await notice($, 'task-notification', { status: 'failed', toolUseId: 'n2' })
  await clock.advance(1)
  expect(ledger().runs['bash:n2']!.status).toBe('failed')
})

test('a row that is not a task notification, or whose status is another word, changes nothing', async ($, on) => {
  const ledger = watchLedger(on)
  drawRows(on)
  const clock = mock.clock(on)
  on('classic.Stop', async () => ({}))
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { backgroundTaskId: 'tN3' } }) as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'n3', run_in_background: true, command: 'sleep 40' } as never)
  await $.classic.Stop(STOPPED)
  await notice($, 'composer', { id: 'tN3', status: 'completed' })
  await clock.advance(1)
  expect(ledger().runs['bash:n3']!.status).toBe('ended')
  await notice($, 'task-notification', { id: 'tN3', status: 'weird' })
  await clock.advance(1)
  expect(ledger().runs['bash:n3']!.status).toBe('ended')
  await notice($, 'task-notification')
  expect(ledger().runs['bash:n3']!.status).toBe('ended')
})

test('the notification row is passed on to the hook beneath and drawn as it makes it', async ($, on) => {
  on('ui.render', { component: 'UserMessage' }, async ($, e) => {
    const { Text } = $.ui.resolve(e) as unknown as { Text: (props: { children: string }) => never }
    return Text({ children: 'MARKER-ROW' })
  })
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { backgroundTaskId: 'tN4' } }) as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'n4', run_in_background: true, command: 'sleep 40' } as never)
  const row = await notice($, 'task-notification', { id: 'tN4', status: 'completed' })
  expect(JSON.stringify(await row.drawn())).toContain('MARKER-ROW')
})
