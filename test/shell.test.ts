import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

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
