import { expect, test } from 'claude-code/testing'

import { workdirKey } from '../../src/ledger'
import { isInsideRoots, projectRelayResult, relayIdentity } from '../../src/relay-result'

const SAMPLE = '{"schema":"delegate-relay.result.v1","lane":"debate","tool":"opencode","agent":"plan","model":"openai/gpt-6.1-sol","variant":"high","status":"completed","exitCode":0,"startedAt":"2026-10-09T12:05:33.841Z","finishedAt":"2026-10-09T12:12:00.928Z","finalMessage":"SENTINEL-FINAL","briefPath":"/tmp/SENTINEL-PATH","touchedFiles":["?? .gitignore"],"cost":0}'

test('opencode relay example projects to the allow-listed fields only', () => {
  const p = projectRelayResult(SAMPLE)
  expect(p?.status).toBe('done')
  expect(p?.implementer).toBe('opencode')
  expect(p?.lane).toBe('debate')
  expect(p?.model).toBe('openai/gpt-6.1-sol')
  expect(p?.effort).toBe('high')
  expect(p?.readOnly).toBe(true)
  expect(p?.costReported).toBe(0)
  expect(p?.usage).toBeNull()
  expect(p?.touchedFiles).toBe(1)
  const json = JSON.stringify(p)
  expect(json).not.toContain('SENTINEL-FINAL')
  expect(json).not.toContain('/tmp/SENTINEL-PATH')
})

test('claude relay example keeps usage and the reported cost', () => {
  const text = '{"schema":"delegate-relay.result.v1","lane":"feature","tool":"claude","status":"completed","usage":{"input_tokens":20,"output_tokens":22104,"cache_read_input_tokens":312365,"cache_creation_input_tokens":0},"totalCostUsd":0.02244}'
  const p = projectRelayResult(text)
  expect(p?.usage).toEqual({ uncached: 20, output: 22104, cacheRead: 312365, cacheWrite: 0 })
  expect(p?.costReported).toBe(0.02244)
})

test('a wrong schema is ignored', () => {
  expect(projectRelayResult('{"schema":"other","status":"completed"}')).toBeNull()
})

test('a result over 1 MiB is ignored', () => {
  expect(projectRelayResult('{"schema":"delegate-relay.result.v1","finalMessage":"' + 'x'.repeat(2 * 1024 * 1024) + '"}')).toBeNull()
})

test('cost, usage and model are type-checked and dropped when wrong', () => {
  expect(projectRelayResult('{"schema":"delegate-relay.result.v1","cost":-1}')?.costReported).toBeNull()
  expect(projectRelayResult('{"schema":"delegate-relay.result.v1","usage":{"input_tokens":"1"}}')?.usage).toBeNull()
  expect(projectRelayResult('{"schema":"delegate-relay.result.v1","model":"x y"}')?.model).toBeUndefined()
})

test('status map: timeout → failed, unknown word → ended', () => {
  expect(projectRelayResult('{"schema":"delegate-relay.result.v1","status":"timeout"}')?.status).toBe('failed')
  expect(projectRelayResult('{"schema":"delegate-relay.result.v1","status":"weird"}')?.status).toBe('ended')
})

test('isInsideRoots is separator-aware and empty roots allow nothing', () => {
  expect(isInsideRoots('/tmp/o1/result.json', ['/tmp'])).toBe(true)
  expect(isInsideRoots('/tmpx/r', ['/tmp'])).toBe(false)
  expect(isInsideRoots('/tmp', ['/tmp/'])).toBe(true)
  expect(isInsideRoots('/home/u/.ssh/x', ['/tmp', '/p'])).toBe(false)
  expect(isInsideRoots('/home/u/.ssh/x', [])).toBe(false)
})

test('a status naming an Object prototype key is ended, not a prototype value', () => {
  const p = projectRelayResult('{"schema":"delegate-relay.result.v1","status":"constructor"}')
  expect(p?.status).toBe('ended')
  expect(projectRelayResult('{"schema":"delegate-relay.result.v1","status":"__proto__"}')?.status).toBe('ended')
})

test('an empty root allows nothing', () => {
  expect(isInsideRoots('/home/u/.ssh/id', [''])).toBe(false)
  expect(isInsideRoots('/tmp/o/result.json', ['', '/tmp'])).toBe(true)
})

test('any versioned relay result schema projects; other schemas do not', () => {
  expect(projectRelayResult('{"schema":"delegate-relay.result.v2","status":"completed","tool":"gemini"}')?.implementer).toBe('gemini')
  expect(projectRelayResult('{"schema":"delegate-relay.result.v12","status":"completed"}')?.status).toBe('done')
  expect(projectRelayResult('{"schema":"delegate-relay.result.v","status":"completed"}')).toBeNull()
  expect(projectRelayResult('{"schema":"delegate-relay.result.v1234","status":"completed"}')).toBeNull()
  expect(projectRelayResult('{"schema":"xdelegate-relay.result.v1","status":"completed"}')).toBeNull()
})

const IDENTITY = '{"schema":"delegate-relay.result.v1","tool":"claude","startedAt":"2026-10-09T12:05:33.841Z","workdir":"/home/u/SENTINEL-WORKDIR","finalMessage":"SENTINEL-FINAL"}'

test('relayIdentity reads the start, the tool and a hash of the working directory', () => {
  const id = relayIdentity(IDENTITY)
  expect(id?.startedAt).toBe(Date.parse('2026-10-09T12:05:33.841Z'))
  expect(id?.tool).toBe('claude')
  expect(id?.workdirKey).toBe(workdirKey('/home/u/SENTINEL-WORKDIR'))
})

test('relayIdentity never returns the working directory or any other field', () => {
  const json = JSON.stringify(relayIdentity(IDENTITY))
  expect(json).not.toContain('SENTINEL-WORKDIR')
  expect(json).not.toContain('SENTINEL-FINAL')
  expect(Object.keys(relayIdentity(IDENTITY) ?? {}).sort()).toEqual(['startedAt', 'tool', 'workdirKey'])
})

test('relayIdentity accepts v1 and v2 and rejects other schemas', () => {
  expect(relayIdentity(IDENTITY.replace('result.v1', 'result.v2'))?.tool).toBe('claude')
  expect(relayIdentity(IDENTITY.replace('delegate-relay.result.v1', 'other'))).toBeNull()
  expect(relayIdentity(IDENTITY.replace('"schema"', '"schemas"'))).toBeNull()
})

test('relayIdentity needs a start time; tool and workdir are optional and type-checked', () => {
  expect(relayIdentity('{"schema":"delegate-relay.result.v1","tool":"claude"}')).toBeNull()
  expect(relayIdentity('{"schema":"delegate-relay.result.v1","startedAt":"not a date"}')).toBeNull()
  const bare = relayIdentity('{"schema":"delegate-relay.result.v1","startedAt":"2026-10-09T12:05:33.841Z","tool":"vim","workdir":5}')
  expect(bare).toEqual({ startedAt: Date.parse('2026-10-09T12:05:33.841Z') })
})

test('relayIdentity returns null for oversize, invalid and non-object JSON', () => {
  expect(relayIdentity('{"schema":"delegate-relay.result.v1","startedAt":"2026-10-09T12:05:33.841Z","finalMessage":"' + 'x'.repeat(2 * 1024 * 1024) + '"}')).toBeNull()
  expect(relayIdentity('{"schema":')).toBeNull()
  expect(relayIdentity('[1,2]')).toBeNull()
  expect(relayIdentity('null')).toBeNull()
})
