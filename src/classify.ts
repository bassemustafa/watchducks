import type { Classification } from '../types'

// Pure Bash classifier (spec §6.2). The raw command is read only in this
// module and is never stored: callers get identifiers and enums back.

const MAX_COMMAND = 4096
const MAX_IDENT = 80
const MAX_PATH = 512
const IDENT = /^[A-Za-z0-9._:/#@+~-]+$/
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

const RELAY_SUFFIXES: ReadonlyArray<readonly [string, 'opencode' | 'claude' | 'codex']> = [
  ['/opencode-delegate/scripts/relay.mjs', 'opencode'],
  ['/claude-delegate/scripts/relay.mjs', 'claude'],
  ['/codex-delegate/scripts/relay.mjs', 'codex'],
]

const RELAY_VALUED = new Set(['--lane', '--model', '--variant', '--effort', '--sandbox', '--agent', '--cd', '--out-dir'])
const CLI_VALUED = new Set(['--model', '-m', '--effort', '--variant'])

type Token = { kind: 'word' | 'op'; value: string; start: number }
type Flag = { name: string; value: string | null }

/** Splits on whitespace; marks `&&`, `||`, `;` and `|` outside quotes as ops. Null on unbalanced quotes. */
function tokenize(text: string): { tokens: Token[]; substitution: boolean } | null {
  const tokens: Token[] = []
  let substitution = false
  let cur = ''
  let start = 0
  let inWord = false
  let i = 0

  const flush = (): void => {
    if (inWord) tokens.push({ kind: 'word', value: cur, start })
    cur = ''
    inWord = false
  }
  const begin = (): void => {
    if (!inWord) {
      inWord = true
      start = i
    }
  }

  while (i < text.length) {
    const ch = text.charAt(i)
    if (ch === "'") {
      begin()
      const end = text.indexOf("'", i + 1)
      if (end < 0) return null
      cur += text.slice(i + 1, end)
      i = end + 1
    } else if (ch === '"') {
      begin()
      i++
      for (;;) {
        if (i >= text.length) return null
        const q = text.charAt(i)
        if (q === '"') {
          i++
          break
        }
        if (q === '\\') {
          const next = text.charAt(i + 1)
          if (next === '"' || next === '\\') {
            cur += next
            i += 2
            continue
          }
        }
        if (q === '`' || (q === '$' && text.charAt(i + 1) === '(')) substitution = true
        cur += q
        i++
      }
    } else if (ch === '\\') {
      if (i + 1 >= text.length) return null
      begin()
      cur += text.charAt(i + 1)
      i += 2
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      flush()
      i++
    } else if (ch === ';' || ch === '|' || (ch === '&' && text.charAt(i + 1) === '&')) {
      flush()
      const op = ch === ';' ? ';' : text.charAt(i + 1) === ch ? ch + ch : ch
      tokens.push({ kind: 'op', value: op, start: i })
      i += op.length
    } else {
      if (ch === '`' || (ch === '$' && text.charAt(i + 1) === '(')) substitution = true
      begin()
      cur += ch
      i++
    }
  }
  flush()
  return { tokens, substitution }
}

/** Shell-like word split: single quotes literal, double quotes escape `"` and `\`, backslash outside quotes. No expansion. Null on unbalanced quotes. */
export function splitWords(text: string): string[] | null {
  const t = tokenize(text)
  return t ? t.tokens.map(tok => tok.value) : null
}

function ident(value: string | null | undefined): string | undefined {
  if (value == null || value.length > MAX_IDENT || !IDENT.test(value)) return undefined
  return value
}

function path(value: string | null | undefined): string | undefined {
  if (value == null || value.length > MAX_PATH || !IDENT.test(value)) return undefined
  if (!value.startsWith('/') && !value.startsWith('~')) return undefined
  if (value.split('/').includes('..')) return undefined
  return value
}

/** Reads `--flag value` and `--flag=value`; a value is never another flag. Positionals are skipped. */
function readFlags(words: string[], from: number, valued: ReadonlySet<string>): Flag[] {
  const flags: Flag[] = []
  for (let i = from; i < words.length; i++) {
    const w = words[i] ?? ''
    if (!w.startsWith('-') || w.length < 2) continue
    const eq = w.startsWith('--') ? w.indexOf('=') : -1
    if (eq > 0) {
      flags.push({ name: w.slice(0, eq), value: w.slice(eq + 1) })
      continue
    }
    if (valued.has(w)) {
      const next = words[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags.push({ name: w, value: next })
        i++
        continue
      }
    }
    flags.push({ name: w, value: null })
  }
  return flags
}

function basename(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1)
}

function classifyRelay(words: string[], workdirPrefix: string | undefined): Classification | null {
  if (basename(words[0] ?? '') !== 'node') return null
  const script = words[1] ?? ''
  const found = RELAY_SUFFIXES.find(([suffix]) => script.endsWith(suffix))
  if (!found) return null

  let lane: string | undefined
  let model: string | undefined
  let effort: string | undefined
  let outDir: string | undefined
  let readOnly = false
  let workdir = workdirPrefix
  for (const { name, value } of readFlags(words, 2, RELAY_VALUED)) {
    if (name === '--lane') lane = ident(value)
    else if (name === '--model') model = ident(value)
    else if (name === '--variant' || name === '--effort') effort = ident(value)
    else if (name === '--read-only') readOnly = value !== 'false' && value !== '0'
    else if (name === '--sandbox' && value === 'read-only') readOnly = true
    else if (name === '--agent' && value === 'plan') readOnly = true
    else if (name === '--cd') workdir = path(value)
    else if (name === '--out-dir') outDir = path(value)
  }

  const out: Classification = { kind: 'relay', implementer: found[1], readOnly }
  if (lane !== undefined) out.lane = lane
  if (model !== undefined) out.model = model
  if (effort !== undefined) out.effort = effort
  if (workdir !== undefined) out.workdir = workdir
  if (outDir !== undefined) out.outDir = outDir
  return out
}

function classifyCli(words: string[], workdir: string | undefined): Classification | null {
  const program = basename(words[0] ?? '')
  const has = (...names: string[]): boolean => words.some(w => names.includes(w) || names.some(n => w.startsWith(n + '=')))
  let implementer: 'codex' | 'opencode' | 'claude' | 'gemini'
  if (program === 'codex' && words[1] === 'exec') implementer = 'codex'
  else if (program === 'opencode' && words[1] === 'run') implementer = 'opencode'
  else if (program === 'claude' && has('-p', '--print')) implementer = 'claude'
  else if (program === 'gemini' && has('-p', '--prompt')) implementer = 'gemini'
  else return null

  let model: string | undefined
  let effort: string | undefined
  for (const { name, value } of readFlags(words, 1, CLI_VALUED)) {
    if (name === '--model' || name === '-m') model = ident(value)
    else if (name === '--effort' || name === '--variant') effort = ident(value)
  }

  const out: Classification = { kind: 'cli', implementer }
  if (model !== undefined) out.model = model
  if (effort !== undefined) out.effort = effort
  if (workdir !== undefined) out.workdir = workdir
  return out
}

export function classify(command: string): Classification {
  const shell = (workdir?: string): Classification => (workdir === undefined ? { kind: 'shell' } : { kind: 'shell', workdir })

  const lexed = tokenize(command)
  if (!lexed) return shell()
  const { tokens, substitution } = lexed

  // One leading `cd <dir> && `.
  let at = 0
  let workdir: string | undefined
  const [t0, t1, t2] = tokens
  if (t0?.kind === 'word' && t0.value === 'cd' && t1?.kind === 'word' && t2?.kind === 'op' && t2.value === '&&') {
    workdir = path(t1.value)
    at = 3
  }
  // Leading `NAME=value` words; their values are never read.
  while (tokens[at]?.kind === 'word' && ENV_ASSIGN.test(tokens[at]!.value)) at++

  const rest = tokens.slice(at)
  const from = rest[0]?.start ?? command.length
  const remaining = command.slice(from)
  if (remaining.length > MAX_COMMAND || /[\n\r]/.test(remaining) || substitution || rest.some(t => t.kind === 'op')) {
    return shell(workdir)
  }

  const words = rest.map(t => t.value)
  return classifyRelay(words, workdir) ?? classifyCli(words, workdir) ?? shell(workdir)
}
