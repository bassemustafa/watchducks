import { expect, test } from 'claude-code/testing'

import { classify, splitWords } from '../../src/classify'

// Fields are read as a record so one helper covers all three Classification kinds.
const c = (command: string) => classify(command) as Record<string, unknown>

test('opencode relay: lane, read-only, cd workdir and out-dir; unknown flag ignored', () => {
  const r = c('node /home/u/.claude/skills/opencode-handoff/scripts/relay.mjs --lane debate --read-only --cd /p/w --brief /tmp/b.md --out-dir /tmp/o1')
  expect(r.kind).toBe('relay')
  expect(r.implementer).toBe('opencode')
  expect(r.lane).toBe('debate')
  expect(r.readOnly).toBe(true)
  expect(r.workdir).toBe('/p/w')
  expect(r.outDir).toBe('/tmp/o1')
})

test('claude relay: --flag=value form, ~ path, model and effort', () => {
  const r = c('node ~/.claude/skills/claude-handoff/scripts/relay.mjs --lane=feature --model claude-sonnet-5-5 --effort high --out-dir /tmp/o2')
  expect(r.kind).toBe('relay')
  expect(r.implementer).toBe('claude')
  expect(r.lane).toBe('feature')
  expect(r.model).toBe('claude-sonnet-5-5')
  expect(r.effort).toBe('high')
  expect(r.readOnly).toBe(false)
  expect(r.outDir).toBe('/tmp/o2')
})

test('codex relay: --sandbox read-only', () => {
  const r = c('node x/codex-handoff/scripts/relay.mjs --sandbox read-only --model gpt-6.1-sol')
  expect(r.kind).toBe('relay')
  expect(r.implementer).toBe('codex')
  expect(r.readOnly).toBe(true)
  expect(r.model).toBe('gpt-6.1-sol')
})

test('opencode relay: --agent plan makes it read-only; --variant is the effort', () => {
  const r = c('node x/opencode-handoff/scripts/relay.mjs --agent plan --variant xhigh')
  expect(r.readOnly).toBe(true)
  expect(r.effort).toBe('xhigh')
})

test('a cd prefix becomes the workdir of the relay', () => {
  const r = c('cd /p/w && node x/opencode-handoff/scripts/relay.mjs --lane review')
  expect(r.kind).toBe('relay')
  expect(r.workdir).toBe('/p/w')
})

test('env assignments are accepted and their values never stored', () => {
  const r = classify('OPENAI_API_KEY=sk-secret node x/opencode-handoff/scripts/relay.mjs --lane quick')
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

test('plain, substituted, multi-line, long and unbalanced commands are shell', () => {
  const shell = [
    'npm test',
    'echo $(cat f)',
    'node "unterminated',
    'node x/claude-handoff/scripts/relay.mjs\n--lane review',
    'node x/claude-handoff/scripts/relay.mjs ' + 'a'.repeat(5000),
  ]
  for (const command of shell) expect(classify(command).kind).toBe('shell')
})

test('a quoted value with spaces is dropped', () => {
  expect(c('node x/claude-handoff/scripts/relay.mjs --model "bad value with spaces"').model).toBeUndefined()
})

test('an 81-character value is dropped', () => {
  expect(c('node x/claude-handoff/scripts/relay.mjs --model ' + 'a'.repeat(81)).model).toBeUndefined()
})

test('an out-dir containing .. is dropped', () => {
  expect(c('node x/opencode-handoff/scripts/relay.mjs --out-dir /tmp/../etc').outDir).toBeUndefined()
})

test('splitWords returns null on unbalanced quotes', () => {
  expect(splitWords('node "unterminated')).toBeNull()
})

test('nothing after a bare -- is read as a flag (codex, claude, relay)', () => {
  expect(c('codex exec -- "--model=SECRET"').model).toBeUndefined()
  expect(c('claude -p "q" -- --model=SECRET').model).toBeUndefined()
  expect(c('node x/opencode-handoff/scripts/relay.mjs --lane quick -- --model=SECRET').model).toBeUndefined()
  expect(c('node x/opencode-handoff/scripts/relay.mjs --lane quick -- --model=SECRET').lane).toBe('quick')
})

test('gemini -p / --prompt take the prompt as their value, which is never read', () => {
  expect(c('gemini -p "--model=SECRET"').model).toBeUndefined()
  expect(c('gemini -p --model=SECRET').model).toBeUndefined()
  expect(c('gemini --prompt=--model=SECRET').model).toBeUndefined()
  expect(c('gemini --prompt --model=SECRET').model).toBeUndefined()
  expect(c('gemini -m gemini-3-pro -p "hi"').model).toBe('gemini-3-pro')
  expect(c('gemini -p "hi" -m gemini-3-pro').model).toBe('gemini-3-pro')
})

test('a gemini prompt flag followed by a bare -- ends flag reading', () => {
  expect(c('gemini -p -- "--model=SECRET"').model).toBeUndefined()
  expect(c('gemini --prompt -- --model=SECRET').model).toBeUndefined()
  expect(c('gemini -m gemini-3-pro -p -- "--model=SECRET"').model).toBe('gemini-3-pro')
})

test('claude -p stays a boolean flag and opencode run still reads its model', () => {
  expect(c('claude -p --model claude-sonnet-5-5 "q"').model).toBe('claude-sonnet-5-5')
  expect(c('opencode run --model x/y "msg"').model).toBe('x/y')
})

test('an oversized command is shell before it is tokenized', () => {
  const relay = ' node x/opencode-handoff/scripts/relay.mjs --lane quick'
  expect(classify('A=' + 'x'.repeat(100_000) + relay).kind).toBe('shell')
  expect(classify('A=' + 'x'.repeat(4000) + relay).kind).toBe('relay')
})

const RELAY = 'node /x/claude-handoff/scripts/relay.mjs --lane quick --brief b --cd /repo'

test('a relay piped into another command is still the relay', () => {
  const r = c(RELAY + ' 2>&1 | tail -5')
  expect(r.kind).toBe('relay')
  expect(r.implementer).toBe('claude')
  expect(r.lane).toBe('quick')
  expect(r.workdir).toBe('/repo')
})

test('commands before or after the relay segment do not change the class', () => {
  expect(c('mkdir -p /tmp/o && ' + RELAY).kind).toBe('relay')
  expect(c('ls; ' + RELAY + ' && echo done').kind).toBe('relay')
  expect(c('node x/claude-handoff/scripts/relay.mjs | tee log').kind).toBe('relay')
  expect(c('echo hi | ' + RELAY).implementer).toBe('claude')
  expect(c('cd /p/w && mkdir -p /tmp/o && node x/codex-handoff/scripts/relay.mjs | tee log').workdir).toBe('/p/w')
})

test('a cd segment inside the chain sets the workdir for the segments after it; the relay own flag wins', () => {
  expect(c('mkdir -p /tmp/o && cd /repo && node /x/claude-handoff/scripts/relay.mjs --lane quick --brief b').workdir).toBe('/repo')
  expect(c('cd /a && node /x/claude-handoff/scripts/relay.mjs --cd /b').workdir).toBe('/b')
  expect(c('mkdir -p /tmp/o; cd /repo; nohup node /x/claude-handoff/scripts/relay.mjs --lane quick &').workdir).toBe('/repo')
  expect(c('cd /a && cd /b && node /x/claude-handoff/scripts/relay.mjs').workdir).toBe('/b')
  expect(c('node /x/claude-handoff/scripts/relay.mjs --lane quick && cd /late').workdir).toBeUndefined()
  expect(c('ls && cd /repo && codex exec "x"').workdir).toBe('/repo')
  expect(c('cd /repo -P && node /x/claude-handoff/scripts/relay.mjs').workdir).toBeUndefined()
})

test('a cd carries to later segments only before && or ;, and a refused dir leaves the workdir unknown', () => {
  const relay = 'node /x/claude-handoff/scripts/relay.mjs --lane quick'
  expect(c('cd /repo && cd /a | ' + relay).workdir).toBe('/repo')
  expect(c('cd /missing || ' + relay).workdir).toBeUndefined()
  expect(c('cd /repo && cd /a || ' + relay).workdir).toBe('/repo')
  expect(c('cd /repo && cd sub && ' + relay).workdir).toBeUndefined()
  expect(c('cd /repo && cd ../x ; ' + relay).workdir).toBeUndefined()
  expect(c('ls && cd /repo ; ' + relay).workdir).toBe('/repo')
})

test('interpreter options that take a value do not hide or become the script', () => {
  expect(c('node --require /srv/delegate/preload.js server.js').kind).toBe('shell')
  expect(c('node -r ts-node/register /x/claude-handoff/scripts/relay.mjs --lane quick').implementer).toBe('claude')
  expect(c('node -r ts-node/register /x/claude-handoff/scripts/relay.mjs --lane quick').kind).toBe('relay')
  for (const option of ['--import', '--loader', '--experimental-loader', '-C', '--conditions', '--env-file', '--title', '--inspect-port']) {
    expect(c(`node ${option} /srv/delegate/v server.js`).kind).toBe('shell')
    expect(c(`node ${option} v /x/codex-handoff/scripts/relay.mjs`).implementer).toBe('codex')
  }
  for (const option of ['-X', '-W', '-Q']) {
    expect(c(`python3 ${option} /srv/delegate/v main.py`).kind).toBe('shell')
    expect(c(`python3 ${option} v /x/gemini-handoff/scripts/relay.py`).implementer).toBe('gemini')
  }
})

test('inline code options in any form leave no script to classify', () => {
  const script = ' /x/claude-handoff/scripts/relay.mjs --lane quick'
  for (const head of [
    'node -e 1', 'node -p 1', 'node --eval 1', 'node --print 1', 'node --eval=1', 'node --print=1', 'node -e1', 'node -pe 1',
    'python3 -c 1', 'python3 -c1', 'python3 -m mod', 'python3 -mmod', 'bash -c 1', 'node --eval="1"',
  ]) {
    expect(c(head + script).kind).toBe('shell')
  }
})

test('a script that is not a relay stays shell, piped or not', () => {
  expect(c('node build.mjs | tail').kind).toBe('shell')
  expect(c('node build.mjs && npm test').kind).toBe('shell')
  expect(c('node -e "x/delegate/relay.js"').kind).toBe('shell')
  expect(c('echo $(cat f) | ' + RELAY).kind).toBe('shell')
})

test('wrappers before the interpreter are skipped and a trailing & is ignored', () => {
  for (const command of [
    'nohup ' + RELAY + ' &',
    'timeout 30m ' + RELAY,
    'timeout -s KILL -k 10 30m ' + RELAY,
    'timeout --signal=KILL 30m ' + RELAY,
    'env FOO=1 ' + RELAY,
    'FOO=1 nice -n 5 ' + RELAY,
    'time setsid ' + RELAY,
    'stdbuf -oL -e0 ' + RELAY,
    'exec ' + RELAY,
    'command ' + RELAY,
    'nohup timeout 1h env A=1 B=2 ' + RELAY + ' 2>&1 &',
  ]) {
    const r = c(command)
    expect(r.kind).toBe('relay')
    expect(r.implementer).toBe('claude')
    expect(r.lane).toBe('quick')
  }
})

test('a relay* script, or any script under a directory named delegate, is a relay whatever the tool', () => {
  const g = c('python3 /opt/agents/delegate/gemini/run_relay.py --out /tmp/x')
  expect(g.kind).toBe('relay')
  expect(g.implementer).toBe('gemini')
  expect(g.outDir).toBe('/tmp/x')
  expect(c('node /srv/delegate/relay.mjs').kind).toBe('relay')
  expect(c('node /srv/delegate/relay.mjs').implementer).toBe('unknown')
  expect(c('bun /srv/tools/relay-v2.js').implementer).toBe('unknown')
  expect(c('deno run -A /srv/tools/relay.ts').kind).toBe('relay')
  expect(c('/opt/tools/relay.py --lane quick').kind).toBe('relay')
  expect(c('bash ./relay.sh').kind).toBe('relay')
})

test('the implementer is the directory nearest the script, then a --tool flag, then unknown', () => {
  expect(c('node /home/u/.claude/skills/opencode-handoff/scripts/relay.mjs').implementer).toBe('opencode')
  expect(c('node /home/u/.codex/skills/x/relay.mjs').implementer).toBe('codex')
  expect(c('node /srv/delegate/relay.mjs --tool gemini').implementer).toBe('gemini')
  expect(c('node /srv/delegate/relay.mjs --implementer=codex').implementer).toBe('codex')
  expect(c('node /srv/delegate/relay.mjs --tool nonsense').implementer).toBe('unknown')
  expect(c('node /home/u/.claude/skills/opencode-handoff/scripts/relay.mjs --tool gemini').implementer).toBe('opencode')
})

test('workdir and out-dir flag aliases', () => {
  const r = c('node /srv/delegate/relay.mjs --cwd /repo --output-dir=/tmp/o3')
  expect(r.workdir).toBe('/repo')
  expect(r.outDir).toBe('/tmp/o3')
  const w = c('node /srv/delegate/relay.mjs --workdir=/w --artifacts-dir /tmp/a')
  expect(w.workdir).toBe('/w')
  expect(w.outDir).toBe('/tmp/a')
  const d = c('node /srv/delegate/relay.mjs --dir /d --artifacts /tmp/b')
  expect(d.workdir).toBe('/d')
  expect(d.outDir).toBe('/tmp/b')
  const k = c('node /srv/delegate/relay.mjs -C /c --outdir /tmp/c')
  expect(k.workdir).toBe('/c')
  expect(k.outDir).toBe('/tmp/c')
  const bad = c('node /srv/delegate/relay.mjs --out-dir /tmp/../etc --cwd rel')
  expect(bad.outDir).toBeUndefined()
  expect(bad.workdir).toBeUndefined()
})

test('a substitution, a newline or an oversized tail makes the command shell even with a relay segment', () => {
  expect(c(RELAY + ' | tail $(echo 5)').kind).toBe('shell')
  expect(c(RELAY + ' | tail\n5').kind).toBe('shell')
  expect(c('ls && ' + RELAY + ' ' + 'a'.repeat(5000)).kind).toBe('shell')
})
