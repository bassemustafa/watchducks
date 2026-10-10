# watchducks

A flock of spy ducks watching every subagent, relay and background run your Claude Code session starts.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/bassemustafa/watchducks/actions/workflows/ci.yml/badge.svg)](https://github.com/bassemustafa/watchducks/actions/workflows/ci.yml)

watchducks is an open-source Claude Code mod (a function-hooks plugin). It tracks the work your session hands to other agents: Agent-tool subagents, delegate relay runs, raw implementer CLIs and background shell commands. For each run it shows status, model, effort, tokens, cache use, cost and review outcome. It reads only numbers, identifiers and enums. It never reads your prompts or answers (see [Privacy](#privacy)).

## What you see

**The sidebar** (`/flock`). Top to bottom:

1. **Header:** a pixel-art duck in a fedora and shades, a radar with one blip per running operative, and the title THE FLOCK.
2. **Counters:** IN FIELD, DEBRIEFED and WENT DARK counts. RETURNED and OFF RADAR appear when they are not zero. (Status words are explained in the [Glossary](#glossary).)
3. **Signal:** a tokens-per-minute sparkline for the last 30 minutes, total tokens, a cache hit bar, spend by implementer, and a dim line for HQ (the main loop).
4. **Operative cards:** one two-line card per tracked run (an "operative"). Line 1: status dot, codename, implementer · model · effort. Line 2: elapsed time, tokens and cost, or the review line. Press a card to open its dossier.
5. **Station board:** see below.

A sketch of the layout (not a screenshot; exact glyphs and spacing differ):

```text
  [duck]   THE FLOCK
  [radar]  ● ● ·

  IN FIELD 2 · DEBRIEFED 3 · WENT DARK 1

  tokens/min  ⣀⣤⣶⣿⣷⣤⣀   412k total
  cache       ████████░░░░  61%
  spend       ██████▒▒▒░░   claude ■ opencode ■
  HQ          96k tok · $0.71

  ● GOLDENEYE-7Q   claude · claude-sonnet-5-5 · high
    4m 12s · 88k tok · $0.42 reported

  ● MALLARD-0K     opencode · glm-5 · —
    1m 03s · — · $0 reported

  ● TEAL-3X        claude-code · claude-opus-5-5 · high
    vetted by SMEW-1A · 2 leaks · 5 patches

  STATION BOARD   [Session | 30 days]
  claude × sonnet-5-5   ████████   4 ops  …
```

**The dossier** is the detail view of one operative: codename, kind, agent type, lane, implementer, model or models, effort and where it came from, read-only flag, status, start, end and duration, the token split, cache %, cost with its source, handler reviews, patches and leaks. It has a Back button. The Agent call's description is not shown.

**The station board** has one row per implementer × model, with a proportional bar (by cost, or by tokens when cost is unknown). Columns: ops, done, failed, tokens, cache %, cost, vetted/ops, and leaks per vetted op. Use the **Session | 30 days** toggle to switch between this session and the last 30 days.

**The band** is one line above the prompt. It shows when the sidebar is not shown and a run is in field or one ended in the last 5 minutes:

```text
🦆 FLOCK  ▸ 2 in field · 3 debriefed · 1 dark   412k tok · 61% cache · $1.84   /flock
```

<!-- screenshots: added after the v0.1 smoke test -->

## Per run

| Field | Meaning |
|---|---|
| Status | running, done, failed, stopped, ended (outcome unknown), or no signal |
| Implementer | `claude-code` (subagent), `claude`, `opencode`, `codex`, `gemini`, `shell` or `unknown` |
| Model | the model last seen (all of them, for a mixed-model run) |
| Effort | observed, reported by the relay, or taken from a flag |
| Tokens | uncached input, output, cache read, cache write |
| Cache % | cache read ÷ total input (uncached + cache read + cache write) |
| Cost | in USD, marked **reported** (from the relay) or **est.** (list-price estimate) |
| Reviews | handler (the reviewer), leaks (bugs found), patches (edit calls) |

**"—"** means the value is not available for that source (for example, tokens for an opencode relay). **"?"** means the value should exist but is unknown (for example, an unpriced model, or a result.json not read yet). A missing value is never shown as 0.

## Glossary

| Term | Plain meaning |
|---|---|
| operative | a tracked run |
| IN FIELD | running |
| DEBRIEFED | done |
| WENT DARK | failed |
| BURNED | stopped |
| RETURNED | ended, outcome unknown |
| OFF RADAR | no signal |
| handler | reviewer |
| vetted | reviewed (only a recorded verdict counts) |
| leaks | bugs |
| patches | edit calls |
| HQ | the main loop |
| codename | a name for a run, such as `GOLDENEYE-7Q`: a duck species plus a two-character suffix |

## Install

Requires Claude Code 2.1.295 or newer.

In a shell:

```sh
claude plugin install watchducks --marketplace bassemustafa/watchducks
```

Inside Claude Code:

```text
/plugin install watchducks --marketplace bassemustafa/watchducks
```

Pass settings at install with `--config key=value`, for example `--config motion=off`, or change them later from the `/plugin` menu.

The docked sidebar needs the fullscreen layout. Elsewhere the sidebar opens inline and the band is shown.

## Coverage

| Source | Identity | Status | Tokens & cache | Cost |
|---|---|---|---|---|
| Agent-tool subagent | agent type; model and effort seen per request | from the spawn result, turn end and agent list | yes, per request | estimated from the price table (Claude models) |
| `claude` relay | from result.json (`lane`, `model`, `effort`) | from result.json | yes, from result.json `usage` | reported (`totalCostUsd`) |
| `opencode` relay | from result.json (`tool`, `model`, `variant`) | from result.json | — | reported only; `$0 reported` under subscription plans |
| `codex` relay | from result.json, when present | from result.json | — | — |
| Raw CLIs: `codex exec`, `opencode run`, `claude -p`, `gemini -p` | implementer, plus `--model`/`-m` if given literally | tool result (foreground) or background snapshots | — | — |
| Other background shell | implementer `shell` | background snapshots | — | — |
| HQ (main loop) | session model | — | yes, per request | estimated; shown separately, never in delegated totals |

> **Pass `--out-dir` to delegate relays.** Without it, the relay's `result.json` cannot be found and its usage shows "—". The out-dir must be under the system temp dir, the session root, or a `relayRoots` entry.

Runs the session did not start are not tracked.

## Commands and tools

| Command | Effect |
|---|---|
| `/flock` | open the sidebar |
| `/flock station` | open the sidebar on the station board |
| `/flock clear` | remove ended runs from the board; running runs stay; history is unaffected |
| `/flock purge` | delete all stored history |

Keys inside the sidebar: `f` field, `s` station, `h` session / 30 days, `b` back. Tab walks the cards.

Tools Claude can call:

- `mcp__watchducks__roster` lists the session's runs (read-only). Each line has codename, kind, implementer, model, lane and status.
- `mcp__watchducks__verdict` records a review: `target`, optional `reviewer`, `bugs`, `edits`. It is the only source of "vetted".

Example: *"Record a verdict: SMEW-1A reviewed GOLDENEYE-7Q, 2 bugs, 5 edits."*

## Settings

| Key | Values | Default | Meaning |
|---|---|---|---|
| `glyphs` | `emoji`, `ascii` | `emoji` | `ascii` draws the duck as `>o)` and status dots as `* + x ~ ?`, for terminals that draw emoji at the wrong width |
| `motion` | `on`, `off` | `on` | animate the radar and status pulses |
| `autoOpen` | `on`, `off` | `on` | open the sidebar beside a fullscreen transcript when the first operative deploys |
| `notify` | `on`, `off` | `off` | show a toast (codename only) when an operative finishes |
| `relayRoots` | path list | empty | extra directories where relay `--out-dir` folders may live; separate entries with `:`; the temp dir and session root are always allowed |
| `priceOverrides` | JSON | empty | per-model prices in USD per million tokens |
| `recordHeadless` | `on`, `off` | `off` | write history from headless sessions (`claude -p`); off avoids double counting relay children |
| `showEngineOverhead` | `on`, `off` | `off` | show the engine's own loops (compaction, memory) as one line |

`priceOverrides` example:

```json
{ "claude-sonnet-5-5": { "input": 2, "output": 10, "cacheRead": 0.2, "cacheWrite": 2.5 } }
```

## Privacy

watchducks keeps only numbers, identifiers and enums. It never inspects, copies, displays, logs or stores any content:

- prompts and agent descriptions
- answers, refusals and thinking
- tool inputs and outputs
- Bash output (stdout, stderr)
- file contents and Edit/Write inputs
- findings text

**Bash commands.** Only a bounded classifier looks at the command line. It recognizes relays and CLIs and picks out flags such as `--lane`, `--model`, `--variant`, `--effort`, `--read-only`, `--sandbox`, `--agent`, `--cd` and `--out-dir`. The command text itself is never stored or shown.

**result.json (read this).** For relay runs, watchducks reads `<out-dir>/result.json`. Reading loads the whole file into the mod's memory for one parse, including the relay's `finalMessage`. Only allow-listed fields are kept:

- `schema` (must be `delegate-relay.result.v1`, otherwise the file is ignored)
- `status`, `exitCode`
- `lane`, `tool`, `model`, `variant`, `effort`
- `agent`, `readOnly`, `sandbox` (used only to set the read-only flag)
- `startedAt`, `finishedAt`
- `cost`, `totalCostUsd`
- numeric `usage` counts: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`
- the length of `touchedFiles` (not the file names)

`finalMessage` and everything else is dropped without being inspected, kept or shown. The file is read only if its real path is inside an allowed root, it is a regular file of at most 1 MiB, and it was not written before the run started (a 5-second slack is allowed).

**Other plugins can read this one's state.** Any installed plugin can read any plugin's state, so watchducks' state holds only allow-listed values.

**On disk.** One history record per session (`history/v1/<sessionId>`) in the plugin store. It holds counts, tokens and costs per UTC day and implementer|model. Records are kept for 30 days, at most 200 of them. Headless sessions record nothing unless `recordHeadless` is on. `/flock purge` deletes all of it.

**No network access. No telemetry.**

See [SECURITY.md](SECURITY.md) for the full data inventory and threat model.

## Costs

Estimated costs use a built-in price table for Claude models, dated 2026-10-06. They are list-price estimates, not invoices or subscription charges. Cache writes are priced at the 5-minute rate.

A cost reported by a relay always wins over an estimate. The two are never added together. A model with no price shows "?" and the run is flagged as partial. Override prices with `priceOverrides`.

## Not yet

Planned for v0.2, not in v0.1:

- an opt-in opencode stats adapter
- a relay metrics sidecar
- a mobile and VS Code sidebar (they get the band only for now)
- terminal animation beyond the radar
- relay result files on native Windows (v0.1 reads them on macOS, Linux and WSL)
- more CLIs

## Development

```sh
npm ci
claude --plugin-dir .
```

Gates:

```sh
claude plugin validate .
npx tsc -p .
claude plugin test .
npm run check:gating
```

`tsc` needs the engine's type declarations, which Claude Code writes when you load the mod with `--plugin-dir`. CI does not run it. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT © 2026 bassemustafa. See [LICENSE](LICENSE). Also: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md).
