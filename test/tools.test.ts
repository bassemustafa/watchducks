import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import type { Ledger } from '../types'
import { emptyLedger } from '../src/ledger'

// The test's `$` has no `state` noun: an observer beneath the plugin sees every ledger the plugin writes.
function watchLedger(on: On): () => Ledger {
  let latest: Ledger = emptyLedger('', 0)
  on('state.set', { plugin: 'watchducks', key: 'ledger' }, async ($, e, next) => {
    latest = e.value as Ledger
    return next(e)
  })
  return () => latest
}

// Every call carries the tool's full input shape (the contents are test data the mod never reads).
const EDIT = { tool: 'Edit', file_path: '/work/a.txt', old_string: 'a', new_string: 'b' }
const FINDINGS = { tool: 'ReportFindings', findings: [] }

test('a verdict naming a codename records the review and answers with codenames only', async ($, on) => {
  const ledger = watchLedger(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  const code = ledger().runs['a1']!.codename
  const answer = await $.tool.call({ tool: 'mcp__watchducks__verdict', target: code, bugs: 2, edits: 1 } as never)
  expect(JSON.stringify(answer)).toContain(`Recorded: HQ vetted ${code} · 2 leaks · 1 patches`)
  expect(ledger().runs['a1']!.reviews.length).toBe(1)
})

test('a verdict with bugs 1.5 answers an error and records no review', async ($, on) => {
  const ledger = watchLedger(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a2' }))
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  const code = ledger().runs['a2']!.codename
  const answer = await $.tool.call({ tool: 'mcp__watchducks__verdict', target: code, bugs: 1.5 } as never)
  expect(JSON.stringify(answer)).toContain('bugs must be an integer 0–10000')
  expect(ledger().runs['a2']!.reviews.length).toBe(0)
})

test('a verdict naming no known run answers target not found', async ($, on) => {
  const ledger = watchLedger(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a6' }))
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  const answer = await $.tool.call({ tool: 'mcp__watchducks__verdict', target: 'nobody' } as never)
  expect(JSON.stringify(answer)).toContain('target not found')
  expect(ledger().runs['a6']!.reviews.length).toBe(0)
})

test('a verdict naming an unknown reviewer answers reviewer not found and records nothing', async ($, on) => {
  const ledger = watchLedger(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a7' }))
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  const code = ledger().runs['a7']!.codename
  const answer = await $.tool.call({ tool: 'mcp__watchducks__verdict', target: code, reviewer: 'nobody', bugs: 1 } as never)
  expect(JSON.stringify(answer)).toContain('reviewer not found')
  expect(ledger().runs['a7']!.reviews.length).toBe(0)
})

test('a verdict without counts shows ? for each', async ($, on) => {
  const ledger = watchLedger(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a8' }))
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  const code = ledger().runs['a8']!.codename
  const answer = await $.tool.call({ tool: 'mcp__watchducks__verdict', target: code } as never)
  expect(JSON.stringify(answer)).toContain(`Recorded: HQ vetted ${code} · ? leaks · ? patches`)
})

test('roster lists each run as codename · kind · implementer · model · lane · status', async ($, on) => {
  const ledger = watchLedger(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a3' }))
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  const code = ledger().runs['a3']!.codename
  const answer = await $.tool.call({ tool: 'mcp__watchducks__roster' } as never)
  expect(JSON.stringify(answer)).toContain(`${code} · agent · claude-code · claude-sonnet-5-5 · — · running`)
})

test('roster with no runs answers No operatives yet.', async $ => {
  const answer = await $.tool.call({ tool: 'mcp__watchducks__roster' } as never)
  expect(JSON.stringify(answer)).toContain('No operatives yet.')
})

test('an Edit whose result is an error does not count as a patch', async ($, on) => {
  const ledger = watchLedger(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a4' }))
  on('tool.call', { tool: 'Edit' }, async () => ({ result: 'failed', isError: true }) as never)
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  await $.tool.call({ ...EDIT, agentId: 'a4', tool_use_id: 'u4' } as never)
  expect(ledger().runs['a4']!.editCalls).toBe(0)
})

test('an Edit that succeeds counts as a patch on the calling run', async ($, on) => {
  const ledger = watchLedger(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a9' }))
  on('tool.call', { tool: 'Edit' }, async () => ({ result: {} }) as never)
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  await $.tool.call({ ...EDIT, agentId: 'a9', tool_use_id: 'u9' } as never)
  expect(ledger().runs['a9']!.editCalls).toBe(1)
})

test('ReportFindings with count 4 records 4 bugs on the reporting run', async ($, on) => {
  const ledger = watchLedger(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a5' }))
  on('tool.call', { tool: 'ReportFindings' }, async () => ({ result: { count: 4 } }) as never)
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  await $.tool.call({ ...FINDINGS, agentId: 'a5', tool_use_id: 'u5' } as never)
  expect(ledger().runs['a5']!.bugsReported).toBe(4)
})
