// Compares the gating hooks `claude plugin validate . --json` reports with test/gating-allowlist.json.
// Exit 0: the same multiset. Exit 1: a hook was added or removed (the diff is printed), or validate did not run.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url).pathname

function collect(node, found) {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, found)
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'gatingHooks' && Array.isArray(value)) found.push(...value)
      else collect(value, found)
    }
  }
}

// an entry as JSON with its keys in a fixed order, so the same hook always compares equal
function canonical(entry) {
  return JSON.stringify(entry, (_key, value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  )
}

// sorted by the entry's JSON string; duplicates are kept, so a second identical hook is a difference
function normalize(entries) {
  return entries.map(canonical).sort()
}

// entries of `a` left over after each one is matched with an equal entry of `b` once
function without(a, b) {
  const left = [...b]
  const extra = []
  for (const entry of a) {
    const at = left.indexOf(entry)
    if (at === -1) extra.push(entry)
    else left.splice(at, 1)
  }
  return extra
}

let report
try {
  report = JSON.parse(execFileSync('claude', ['plugin', 'validate', '.', '--json'], { cwd: root, encoding: 'utf8' }))
} catch (error) {
  console.error('check-gating: `claude plugin validate . --json` failed: ' + (error instanceof Error ? error.message : 'unknown error'))
  process.exit(1)
}

const found = []
collect(report, found)
const actual = normalize(found)
const expected = normalize(JSON.parse(readFileSync(new URL('../test/gating-allowlist.json', import.meta.url), 'utf8')))

const added = without(actual, expected)
const removed = without(expected, actual)

if (added.length === 0 && removed.length === 0) {
  console.log(`check-gating: ${actual.length} gating hooks, all in the allow-list`)
  process.exit(0)
}
for (const entry of added) console.error('+ ' + entry)
for (const entry of removed) console.error('- ' + entry)
console.error('check-gating: the gating hooks differ from test/gating-allowlist.json (+ new, - gone)')
process.exit(1)
