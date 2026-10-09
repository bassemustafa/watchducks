import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { Ledger } from '../types'
import { emptyLedger } from '../src/ledger'

const USAGE = { model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// The step result the test answers beneath the plugin; the engine's own fields are filled for the type only.
const STEP_RESULT = { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE } as never

// The test's `$` has no `state` noun: an observer beneath the plugin sees every ledger the plugin writes.
function watchLedger(on: On): () => Ledger {
  let latest: Ledger = emptyLedger('', 0)
  on('state.set', { plugin: 'watchducks', key: 'ledger' }, async ($, e, next) => {
    latest = e.value as Ledger
    return next(e)
  })
  return () => latest
}

test('a spawn answered with an agent id creates an agent run', async ($, on) => {
  const ledger = watchLedger(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  expect(ledger().runs['a1']!.kind).toBe('agent')
})

test('a turn.step whose result has usage sets the run usage', async ($, on) => {
  const ledger = watchLedger(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('turn.step', async function* () {
    return STEP_RESULT
  })
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  for await (const _ of $.turn.step({ agentId: 'a1', turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'high' } as never)) {
    /* chunks are never read */
  }
  expect(ledger().runs['a1']!.usage).toEqual({ uncached: 1000, output: 100, cacheRead: 0, cacheWrite: 0 })
})

test('a turn.complete with reason answer ends the run as done', async ($, on) => {
  const ledger = watchLedger(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('turn.complete', async () => ({ text: '' }))
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  await $.turn.complete({ agentId: 'a1', turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false } as never)
  expect(ledger().runs['a1']!.status).toBe('done')
})

test('a denied spawn creates no run', async ($, on) => {
  const ledger = watchLedger(on)
  const before = Object.keys(ledger().runs).length
  on('agent.spawn', async () => ({ deny: 'not now' }))
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  expect(Object.keys(ledger().runs).length).toBe(before)
})

test('a second session.start with the same session id keeps the runs', async ($, on) => {
  const ledger = watchLedger(on)
  on('command.register', async () => ({ value: { command: 'flock' } }))
  on('session.id', async () => ({ value: 'S1' }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  mock.store(on)
  mock.clock(on)
  const start = { cwd: '/work', surface: null, isInteractive: true }
  await $.session.start(start)
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  const before = ledger().runs
  expect(Object.keys(before)).toEqual(['a1'])
  await $.session.start(start)
  await $.session.start(start)
  expect(ledger().runs).toEqual(before)
})

test('a classic SubagentStop with background_tasks passes through and keeps the runs', async ($, on) => {
  const ledger = watchLedger(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('classic.SubagentStop', async () => ({}))
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  const stopped = await $.classic.SubagentStop({
    stop_hook_active: false,
    agent_id: 'a1',
    agent_transcript_path: '',
    agent_type: 'Explore',
    background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: '' }],
  })
  expect(stopped).toEqual({})
  expect(Object.keys(ledger().runs)).toEqual(['a1'])
})

test('session.end with reason clear writes the old history and starts an empty ledger under the new id', async ($, on) => {
  const ledger = watchLedger(on)
  let sessionId = 'S1'
  const written: string[] = []
  on('command.register', async () => ({ value: { command: 'flock' } }))
  on('session.id', async () => ({ value: sessionId }))
  on('session.surfaces', async () => ({ value: ['terminal'] }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.end', async () => ({ sessionId: 'S1' }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('store.keys', async () => ({ value: [] }))
  on('store.set', async ($, e) => {
    written.push(e.key)
    return { value: undefined }
  })
  mock.clock(on)
  await $.session.start({ cwd: '/work', surface: null, isInteractive: true })
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  const old = ledger()
  sessionId = 'S2'
  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
  const fresh = ledger()
  expect(written).toEqual(['history/v1/S1'])
  expect(fresh.sessionId).toBe('S2')
  expect(fresh.generation).toBe(old.generation + 1)
  expect(Object.keys(fresh.runs)).toEqual([])
})
