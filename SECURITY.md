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
- **The Bash command line.** Only a bounded classifier reads it, to recognize relays and raw CLIs and to pick out flags (`--lane`, `--model`, `--variant`, `--effort`, `--read-only`, `--sandbox`, `--agent`, `--tool`, `--implementer`; working directory from `--cd`, `--cwd`, `--workdir`, `--dir`, `-C`; out-dir from `--out-dir`, `--outdir`, `--output-dir`, `--out`, `--artifacts-dir`, `--artifacts`). The command text is never stored or shown. Bash output is not read.
- **Relay result.json.** For relay runs, watchducks reads `<out-dir>/result.json`. Reading loads the whole file into the mod's memory for one parse, including the relay's `finalMessage`. Only allow-listed fields are kept: `schema`, `status`, `exitCode`, `lane`, `tool`, `model`, `variant`, `effort`, `agent`, `readOnly`, `sandbox`, `startedAt`, `finishedAt`, `cost`, `totalCostUsd`, four numeric `usage` counts and the length of `touchedFiles`. `finalMessage` and everything else is dropped without being inspected, kept or shown. The file is read only if:
  - its real path (symlinks resolved) is inside an allowed root: the system temp dir, `/tmp`, the session root, or a `relayRoots` entry;
  - it is a regular file of at most 1 MiB;
  - it was not written before the run started (5 seconds of slack).
- **Discovery (relay run without `--out-dir`).** While such a run is running, or ended less than 2 minutes ago, watchducks lists folders under the allowed roots: the system temp dir, `/tmp` and `relayRoots` entries (two levels deep each) and the session root (one level deep). Links are never followed. Folder names are read only to walk the tree and are never stored. A candidate's `result.json` is read only if it is a regular file of at most 1 MiB, modified since the run started, and its real path is inside an allowed root. From it only `schema`, `startedAt`, `tool` and `workdir` are read, and `workdir` is hashed at once. Only the matched folder's path is stored, as that run's out-dir. Per pass: at most 512 `stat` calls, 32 file reads and 2048 entries per listed folder. Remembered per file: its start, tool and workdir hash, for at most 1024 files.
- **Plugin state.** Holds only allow-listed run values. Other installed plugins can read it.
- **Plugin store.** One history record per session (`history/v1/<sessionId>`): counts, tokens and costs per UTC day and implementer|model. Records older than 30 days are pruned and at most 200 are kept. Headless sessions do not record unless `recordHeadless` is on. `/flock purge` deletes all records.
- **Not used:** network access, process spawning, model calls, session messages, transcript appends.

## Threat model

| Threat | Mitigation |
|---|---|
| Hostile command text | The classifier accepts one leading `cd <dir> &&` and leading `NAME=value` words. It splits the rest at `&&`, `\|\|`, `;` and `\|`; the first part that runs a relay or CLI gives the class, and what follows does not change it. A command with a newline, `$(`, or a backtick, or over the length cap (4,096 characters after the leading `cd` and `NAME=value` words, 8,192 in all), is never read as a relay or CLI: it is tracked as a plain shell run. Extracted identifiers are at most 80 characters of `[A-Za-z0-9._:/#@+~-]`. Paths are at most 512 characters, must start with `/` or `~`, and may not contain a `..` segment. Anything else is dropped. Environment values are never read. |
| Hostile or oversized result.json | Schema check (`delegate-relay.result.v<N>`), 1 MiB cap, regular-file check, per-field type and range checks, root allow-list on the resolved real path, freshness check against the run start. Anything that fails is ignored. |
| A planted `result.json` from a local process that can write in a temp folder | It could write a `result.json` that matches a pending run and attach false numbers (status, tokens, cost) to it. Mitigations: pairing only when the start is between 5 s before and 60 s after the run started, tool and working-directory match wherever both are known, freshness check against the run start, regular file and no links, 1 MiB cap, per-field type and range checks, and only allow-listed fields are kept. Residual risk: such a process can still spoof the numbers watchducks shows for a relay. This is display only: nothing is executed and no content is shown. |
| Other plugins reading state | State holds only allow-listed values. |
| Price-table drift | The table is dated, can be overridden with `priceOverrides`, and a cost reported by a relay is preferred over an estimate. Unknown models show "?" and are never given a default price. |
| Store growth | 30-day pruning and a cap of 200 records. |

## Residual risks

- **Stat-then-read race.** watchducks checks the file with a stat, then reads it. A file swapped between the two could be read once. Its content still goes through the same projection, so only allow-listed fields are kept.
- **Whole file in memory.** result.json, including `finalMessage`, is in memory for one parse.
- **State is readable by other plugins.** Values in state are allow-listed, but they are not secret from other installed plugins.
- **Discovery reads folder names.** While a relay runs without an `--out-dir`, discovery reads the names of folders in the allowed roots. The names are read transiently and never stored.
- **Large folders are listed in full.** The engine's folder listing has no limit, so discovery receives a folder's whole listing before it keeps the first 2048 entries. A folder with a very large number of entries in an allowed root makes one discovery pass slower. Each pass also stops after about 2 seconds.
- **A folder swapped during a pass.** Between the check that a folder is a real folder and its listing, a local process could swap it for a link, and discovery would read the names in the folder the link points to. Names are not stored, and a result.json is read only if its resolved path is inside an allowed root.
- **Results rewritten in old folders are not found.** Discovery looks only in folders created or changed since the run started. A relay that rewrites a result.json inside an older folder, without `--out-dir`, is not found. Relays that create a new folder per run, and any run given `--out-dir`, are not affected.
- **Late starts are not matched.** A result is paired with a run only when its start is between 5 seconds before and 60 seconds after the Bash call. A relay started later in the same command (for example after `sleep 90`) is not found by discovery; pass `--out-dir` for such commands.

## Mod standards

- Observer hooks on tools pass the call through unchanged and fail open: if watchducks fails, the call proceeds as if watchducks were not installed.
- The only hooks that answer tool calls are watchducks' own two tools, `mcp__watchducks__roster` and `mcp__watchducks__verdict`.
- CI compares the gating hooks reported by the engine with `test/gating-allowlist.json` and fails on any difference.
