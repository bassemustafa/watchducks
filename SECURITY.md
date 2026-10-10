# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes |

## Reporting a vulnerability

Report privately through GitHub security advisories: <https://github.com/bassemustafa/watchducks/security/advisories/new> (the "Report a vulnerability" button on the Security tab). Do not open a public issue.

Please include:

- the watchducks version
- the Claude Code version
- steps to reproduce
- the impact you see

Do not include real prompts, transcripts or secrets. Use made-up values.

We aim to acknowledge a report within 7 days. There is no bounty.

## What watchducks touches

- **Engine events.** Metadata only: ids, enums, models, efforts, token counts. The engine hands hooks full events that can contain text. watchducks never reads the content fields (prompts, descriptions, answers, thinking, tool inputs and outputs, findings). A privacy test plants sentinel strings in every content field and checks that none reaches state, store, toasts or rendered output.
- **The Bash command line.** Only a bounded classifier reads it, to recognize relays and raw CLIs and to pick out flags (`--lane`, `--model`, `--variant`, `--effort`, `--read-only`, `--sandbox`, `--agent`, `--cd`, `--out-dir`). The command text is never stored or shown. Bash output is not read.
- **Relay result.json.** For relay runs, watchducks reads `<out-dir>/result.json`. Reading loads the whole file into the mod's memory for one parse, including the relay's `finalMessage`. Only allow-listed fields are kept: `schema`, `status`, `exitCode`, `lane`, `tool`, `model`, `variant`, `effort`, `agent`, `readOnly`, `sandbox`, `startedAt`, `finishedAt`, `cost`, `totalCostUsd`, four numeric `usage` counts and the length of `touchedFiles`. `finalMessage` and everything else is dropped without being inspected, kept or shown. The file is read only if:
  - its real path (symlinks resolved) is inside an allowed root: the system temp dir, `/tmp`, the session root, or a `relayRoots` entry;
  - it is a regular file of at most 1 MiB;
  - it was not written before the run started (5 seconds of slack).
- **Plugin state.** Holds only allow-listed run values. Other installed plugins can read it.
- **Plugin store.** One history record per session (`history/v1/<sessionId>`): counts, tokens and costs per UTC day and implementer|model. Records older than 30 days are pruned and at most 200 are kept. Headless sessions do not record unless `recordHeadless` is on. `/flock purge` deletes all records.
- **Not used:** network access, process spawning, model calls, session messages, transcript appends.

## Threat model

| Threat | Mitigation |
|---|---|
| Hostile command text | The classifier accepts one leading `cd <dir> &&` and leading `NAME=value` words. After that, a command over 4,096 characters, or one with a newline, `$(`, a backtick, `&&`, `\|\|`, `;` or a pipe, is never read as a relay or CLI: it is tracked as a plain shell run. Extracted identifiers are at most 80 characters of `[A-Za-z0-9._:/#@+~-]`. Paths are at most 512 characters, must start with `/` or `~`, and may not contain a `..` segment. Anything else is dropped. Environment values are never read. |
| Hostile or oversized result.json | Schema check (`delegate-relay.result.v1`), 1 MiB cap, regular-file check, per-field type and range checks, root allow-list on the resolved real path, freshness check against the run start. Anything that fails is ignored. |
| Other plugins reading state | State holds only allow-listed values. |
| Price-table drift | The table is dated, can be overridden with `priceOverrides`, and a cost reported by a relay is preferred over an estimate. Unknown models show "?" and are never given a default price. |
| Store growth | 30-day pruning and a cap of 200 records. |

## Residual risks

- **Stat-then-read race.** watchducks checks the file with a stat, then reads it. A file swapped between the two could be read once. Its content still goes through the same projection, so only allow-listed fields are kept.
- **Whole file in memory.** result.json, including `finalMessage`, is in memory for one parse.
- **State is readable by other plugins.** Values in state are allow-listed, but they are not secret from other installed plugins.

## Mod standards

- Observer hooks on tools pass the call through unchanged and fail open: if watchducks fails, the call proceeds as if watchducks were not installed.
- The only hooks that answer tool calls are watchducks' own two tools, `mcp__watchducks__roster` and `mcp__watchducks__verdict`.
- CI compares the gating hooks reported by the engine with `test/gating-allowlist.json` and fails on any difference.
