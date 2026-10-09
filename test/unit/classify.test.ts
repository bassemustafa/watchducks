import { expect, test } from 'claude-code/testing'

import { classify, splitWords } from '../../src/classify'

// Fields are read as a record so one helper covers all three Classification kinds.
const c = (command: string) => classify(command) as Record<string, unknown>

test('opencode relay: lane, read-only, cd workdir and out-dir; unknown flag ignored', () => {
  const r = c('node /home/u/.claude/skills/opencode-delegate/scripts/relay.mjs --lane debate --read-only --cd /p/w --brief /tmp/b.md --out-dir /tmp/o1')
  expect(r.kind).toBe('relay')
  expect(r.implementer).toBe('opencode')
  expect(r.lane).toBe('debate')
  expect(r.readOnly).toBe(true)
  expect(r.workdir).toBe('/p/w')
  expect(r.outDir).toBe('/tmp/o1')
})

test('claude relay: --flag=value form, ~ path, model and effort', () => {
  const r = c('node ~/.claude/skills/claude-delegate/scripts/relay.mjs --lane=feature --model claude-sonnet-5-5 --effort high --out-dir /tmp/o2')
  expect(r.kind).toBe('relay')
  expect(r.implementer).toBe('claude')
  expect(r.lane).toBe('feature')
  expect(r.model).toBe('claude-sonnet-5-5')
  expect(r.effort).toBe('high')
  expect(r.readOnly).toBe(false)
  expect(r.outDir).toBe('/tmp/o2')
})

test('codex relay: --sandbox read-only', () => {
  const r = c('node x/codex-delegate/scripts/relay.mjs --sandbox read-only --model gpt-6.1-sol')
  expect(r.kind).toBe('relay')
  expect(r.implementer).toBe('codex')
  expect(r.readOnly).toBe(true)
  expect(r.model).toBe('gpt-6.1-sol')
})

test('opencode relay: --agent plan makes it read-only; --variant is the effort', () => {
  const r = c('node x/opencode-delegate/scripts/relay.mjs --agent plan --variant xhigh')
  expect(r.readOnly).toBe(true)
  expect(r.effort).toBe('xhigh')
})

test('a cd prefix becomes the workdir of the relay', () => {
  const r = c('cd /p/w && node x/opencode-delegate/scripts/relay.mjs --lane review')
  expect(r.kind).toBe('relay')
  expect(r.workdir).toBe('/p/w')
})

test('env assignments are accepted and their values never stored', () => {
  const r = classify('OPENAI_API_KEY=sk-secret node x/opencode-delegate/scripts/relay.mjs --lane quick')
  expect(r.kind).toBe('relay')
  expect(JSON.stringify(r)).not.toContain('sk-secret')
})

test('codex exec: model kept, prompt never stored', () => {
  const r = classify('codex exec -m gpt-6.1-sol "fix the bug"') as Record<string, unknown>
  expect(r.kind).toBe('cli')
  expect(r.implementer).toBe('codex')
  expect(r.model).toBe('gpt-6.1-sol')
  expect(JSON.stringify(r)).not.toContain('fix the bug')
})

test('opencode run keeps a provider/model id', () => {
  const r = c('opencode run --model openai/gpt-6.1-sol "x"')
  expect(r.kind).toBe('cli')
  expect(r.implementer).toBe('opencode')
  expect(r.model).toBe('openai/gpt-6.1-sol')
})

test('claude -p: model kept, prompt never stored', () => {
  const r = classify('claude -p "secret prompt" --model claude-haiku-5-5') as Record<string, unknown>
  expect(r.kind).toBe('cli')
  expect(r.implementer).toBe('claude')
  expect(r.model).toBe('claude-haiku-5-5')
  expect(JSON.stringify(r)).not.toContain('secret prompt')
})

test('gemini --prompt is a raw CLI', () => {
  expect(c('gemini --prompt hi').implementer).toBe('gemini')
  expect(c('gemini --prompt hi').kind).toBe('cli')
})

test('plain, chained, piped, substituted, multi-line, long and unbalanced commands are shell', () => {
  const shell = [
    'npm test',
    'ls; node x/claude-delegate/scripts/relay.mjs',
    'node x/claude-delegate/scripts/relay.mjs | tee log',
    'echo $(cat f)',
    'node "unterminated',
    'node x/claude-delegate/scripts/relay.mjs\n--lane review',
    'node x/claude-delegate/scripts/relay.mjs ' + 'a'.repeat(5000),
  ]
  for (const command of shell) expect(classify(command).kind).toBe('shell')
})

test('a quoted value with spaces is dropped', () => {
  expect(c('node x/claude-delegate/scripts/relay.mjs --model "bad value with spaces"').model).toBeUndefined()
})

test('an 81-character value is dropped', () => {
  expect(c('node x/claude-delegate/scripts/relay.mjs --model ' + 'a'.repeat(81)).model).toBeUndefined()
})

test('an out-dir containing .. is dropped', () => {
  expect(c('node x/opencode-delegate/scripts/relay.mjs --out-dir /tmp/../etc').outDir).toBeUndefined()
})

test('splitWords returns null on unbalanced quotes', () => {
  expect(splitWords('node "unterminated')).toBeNull()
})
