import type { Classification } from '../types'

// Pure Bash classifier (spec §6.2). The raw command is read only in this
// module and is never stored: callers get identifiers and enums back.

const MAX_COMMAND = 4096
const MAX_IDENT = 80
const MAX_PATH = 512
const IDENT = /^[A-Za-z0-9._:/#@+~-]+$/
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

type Tool = 'opencode' | 'codex' | 'gemini' | 'claude'
/** Looked for in a script's directory names, nearest the file first; one directory names the first of these it contains. */
const TOOLS: readonly Tool[] = ['opencode', 'codex', 'gemini', 'claude']

const INTERPRETERS = new Set(['node', 'bun', 'deno', 'tsx', 'python', 'python3', 'bash', 'sh'])
const SCRIPT_EXT = /\.(?:mjs|cjs|js|ts|mts|cts|py|sh|bash)$/
/** Interpreter options that take code, not a script. */
const CODE_FLAGS = new Set(['-c', '-e', '-p', '-m', '--eval', '--print'])
const WORKDIR_FLAGS = new Set(['--cd', '--cwd', '--workdir', '--dir', '-C'])
const OUT_DIR_FLAGS = new Set(['--out-dir', '--outdir', '--output-dir', '--out', '--artifacts-dir', '--artifacts'])
const RELAY_VALUED = new Set([
  '--lane', '--model', '--variant', '--effort', '--sandbox', '--agent', '--tool', '--implementer',
  ...WORKDIR_FLAGS, ...OUT_DIR_FLAGS,
])
const CLI_VALUED = new Set(['--model', '-m', '--effort', '--variant'])
const GEMINI_PROMPT = new Set(['-p', '--prompt'])
const NO_FLAGS: ReadonlySet<string> = new Set()

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

/**
 * Reads `--flag value` and `--flag=value`; a value is never another flag. Positionals are skipped.
 * Nothing after a bare `--` is read. A `prompt` flag takes the prompt as its value: that word is
 * consumed unread and `--flag=...` is dropped.
 */
function readFlags(words: string[], from: number, valued: ReadonlySet<string>, prompt: ReadonlySet<string> = NO_FLAGS): Flag[] {
  const flags: Flag[] = []
  for (let i = from; i < words.length; i++) {
    const w = words[i] ?? ''
    if (w === '--') break
    if (!w.startsWith('-') || w.length < 2) continue
    const eq = w.startsWith('--') ? w.indexOf('=') : -1
    if (prompt.has(eq > 0 ? w.slice(0, eq) : w)) {
      if (eq < 0) {
        // a bare `--` after the flag ends flag reading: what follows is never a flag
        if (words[i + 1] === '--') break
        i++
      }
      continue
    }
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

/** Index of the script word when the segment runs one (`node x.mjs`, `deno run x.ts`, or `./x.py` itself); -1 otherwise. */
function scriptIndex(words: string[]): number {
  const program = basename(words[0] ?? '')
  if (SCRIPT_EXT.test(program)) return 0
  if (!INTERPRETERS.has(program) && !/^python[0-9.]+$/.test(program)) return -1
  let i = 1
  if (program === 'deno' && words[i] === 'run') i++
  while ((words[i] ?? '').startsWith('-')) {
    if (CODE_FLAGS.has(words[i]!)) return -1
    i++
  }
  const script = words[i]
  return script === undefined || /\s/.test(script) ? -1 : i
}

function toolIn(dirs: string[]): Tool | undefined {
  for (let i = dirs.length - 1; i >= 0; i--) {
    const dir = (dirs[i] ?? '').toLowerCase()
    const found = TOOLS.find(t => dir.includes(t))
    if (found) return found
  }
  return undefined
}

function classifyRelay(words: string[], workdirPrefix: string | undefined): Classification | null {
  const at = scriptIndex(words)
  if (at < 0) return null
  const script = words[at] ?? ''
  const dirs = script.split('/').slice(0, -1)
  if (!basename(script).toLowerCase().startsWith('relay') && !dirs.some(d => d.toLowerCase().includes('delegate'))) return null

  let lane: string | undefined
  let model: string | undefined
  let effort: string | undefined
  let outDir: string | undefined
  let flagTool: Tool | undefined
  let readOnly = false
  let workdir = workdirPrefix
  for (const { name, value } of readFlags(words, at + 1, RELAY_VALUED)) {
    if (name === '--lane') lane = ident(value)
    else if (name === '--model') model = ident(value)
    else if (name === '--variant' || name === '--effort') effort = ident(value)
    else if (name === '--read-only') readOnly = value !== 'false' && value !== '0'
    else if (name === '--sandbox' && value === 'read-only') readOnly = true
    else if (name === '--agent' && value === 'plan') readOnly = true
    else if (name === '--tool' || name === '--implementer') flagTool = TOOLS.find(t => t === value) ?? flagTool
    else if (WORKDIR_FLAGS.has(name)) workdir = path(value)
    else if (OUT_DIR_FLAGS.has(name)) outDir = path(value)
  }

  const out: Classification = { kind: 'relay', implementer: toolIn(dirs) ?? flagTool ?? 'unknown', readOnly }
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
  for (const { name, value } of readFlags(words, 1, CLI_VALUED, implementer === 'gemini' ? GEMINI_PROMPT : NO_FLAGS)) {
    if (name === '--model' || name === '-m') model = ident(value)
    else if (name === '--effort' || name === '--variant') effort = ident(value)
  }

  const out: Classification = { kind: 'cli', implementer }
  if (model !== undefined) out.model = model
  if (effort !== undefined) out.effort = effort
  if (workdir !== undefined) out.workdir = workdir
  return out
}

/** Words with the wrappers (`nohup`, `timeout 30m`, `env A=1`, ...), `NAME=value` words and a trailing `&` removed. */
function stripWrappers(segment: string[]): string[] {
  const words = segment.slice()
  while (words.length > 1 && words[words.length - 1] === '&') words.pop()
  let i = 0
  for (;;) {
    while (ENV_ASSIGN.test(words[i] ?? '')) i++
    const word = words[i]
    if (word === undefined) return []
    const name = basename(word)
    if (name === 'nohup' || name === 'exec' || name === 'command' || name === 'env') {
      i++
    } else if (name === 'time' || name === 'setsid') {
      i++
      while ((words[i] ?? '').startsWith('-')) i++
    } else if (name === 'timeout') {
      i++
      for (;;) {
        const opt = words[i] ?? ''
        if (opt === '-s' || opt === '-k' || opt === '--signal' || opt === '--kill-after') i += 2
        else if (opt.startsWith('-')) i++
        else break
      }
      i++ // the duration
    } else if (name === 'nice') {
      i++
      if (words[i] === '-n') i += 2
      else if ((words[i] ?? '').startsWith('-')) i++
    } else if (name === 'stdbuf') {
      i++
      while ((words[i] ?? '').startsWith('-')) i += /^-[oei]$/.test(words[i]!) ? 2 : 1
    } else {
      return words.slice(i)
    }
  }
}

export function classify(command: string): Classification {
  const shell = (workdir?: string): Classification => (workdir === undefined ? { kind: 'shell' } : { kind: 'shell', workdir })

  if (command.length > MAX_COMMAND * 2) return shell()

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
  if (remaining.length > MAX_COMMAND || /[\n\r]/.test(remaining) || substitution) return shell(workdir)

  // The first segment (split at `&&`, `||`, `;`, `|`) that runs a relay or a CLI gives the class;
  // what follows it (`| tail`, `&& echo done`) never changes it.
  let segment: string[] = []
  const segments: string[][] = []
  for (const t of rest) {
    if (t.kind === 'op') {
      segments.push(segment)
      segment = []
    } else {
      segment.push(t.value)
    }
  }
  segments.push(segment)
  // A segment that is exactly `cd <dir>` sets the workdir for the segments after it.
  let current = workdir
  for (const seg of segments) {
    const words = stripWrappers(seg)
    if (words.length === 0) continue
    if (words.length === 2 && words[0] === 'cd') {
      current = path(words[1])
      continue
    }
    const found = classifyRelay(words, current) ?? classifyCli(words, current)
    if (found) return found
  }
  return shell(workdir)
}
