# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.2.x | yes |
| 0.1.x | no |

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
- **opencode stats (opt-in).** Only when `opencodeStats` is on, watchducks runs one fixed process: `opencode stats --json --days 1 --models --cost --project .`, with `opencode` found on PATH. The working directory (`cwd`) is the run's folder, else the session root; no path is ever an argument. Timeout 10 s, and one process at a time. Stdout is capped at 1 MiB and parsed through an allow-list, read by name: the session count, the token counts, the cost, and for each model (at most 64) its id, provider id and the same numbers. Anything else in the output is dropped. Stderr is never read.
- **Child report files.** A child session writes `<temp dir>/watchducks-children/<parent hash>/<session id>.json` (temp dir: `TMPDIR`, else `/tmp`; parent hash: a fingerprint of the parent's session id). The file name is the child's session id, accepted only when it matches `[A-Za-z0-9_-]` and is 1 to 128 characters. The file is at most 64 KiB, has the schema `watchducks.child.v1`, and holds only the fields listed in the [README](README.md#privacy). A report that fails the schema, size, row cap (32) or any type or range check is rejected whole. The parent lists only its own folder, every 3 s, reads at most 256 entries per list, never follows links, and reads only regular files of at most 64 KiB whose real path is inside the temp root. A file unchanged in mtime and size is not read again. Reports whose `updatedAt` is older than 24 h are ignored. watchducks never deletes these files; see Residual risks.
- **Environment.** Read by name only: `CLAUDE_CODE_SESSION_ID` (to tell whether this session is a child of another Claude Code session), `TMPDIR` (the temp root), `HOME` (to expand `~` in paths) and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (to skip the price refresh).
- **Plugin state.** Holds only allow-listed run values. Other installed plugins can read it.
- **Plugin store.** One history record per session (`history/v1/<sessionId>`): counts, tokens and costs per UTC day and implementer|model. Records older than 30 days are pruned and at most 200 are kept. Headless sessions do not record unless `recordHeadless` is on. `/flock purge` deletes all history records; the price record below is kept. The refreshed price record (`prices/litellm/v1`) holds its fetch and attempt times and four numbers per chat model.
- **Price refresh (`priceUpdates`, on by default).** One GET, through the Claude Code host, to `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` (LiteLLM's public price list). It sends no headers, query or body, and nothing about the user or the session. It runs at most once a day, with one attempt an hour after a failure, checked at session start and about hourly; it never blocks a hook. It is skipped when `priceUpdates` is `off`, when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, or when the organization's web-fetch policy refuses it. The answer is capped at 8 MiB and projected to four numbers per chat model (input, output, cache read, cache write): keys lower-cased and checked, values non-negative and at most 10,000 USD per million tokens, at most 6,000 models kept. Fewer than 100 valid entries means the answer is ignored.
- **Bundled price snapshot.** `src/prices-litellm.ts` holds the same projection of LiteLLM's list, dated 2026-10-16. It is regenerated at release time by `scripts/update-prices.mjs`, which the plugin never runs. It is used when the refresh is off, has failed, or has not fetched a list.
- **Not used:** network use other than the price refresh, any process other than `opencode stats`, model calls, session messages, transcript appends, Bash output, and any session store, database, server API or transcript.

## Threat model

| Threat | Mitigation |
|---|---|
| Hostile command text | The classifier accepts one leading `cd <dir> &&` and leading `NAME=value` words. It splits the rest at `&&`, `\|\|`, `;` and `\|`; the first part that runs a relay or CLI gives the class, and what follows does not change it. A command with a newline, `$(`, or a backtick, or over the length cap (4,096 characters after the leading `cd` and `NAME=value` words, 8,192 in all), is never read as a relay or CLI: it is tracked as a plain shell run. Extracted identifiers are at most 80 characters of `[A-Za-z0-9._:/#@+~-]`. Paths are at most 512 characters, must start with `/` or `~`, and may not contain a `..` segment. Anything else is dropped. Environment values are read only by name, as listed under What watchducks touches. |
| Hostile or oversized result.json | Schema check (`delegate-relay.result.v<N>`), 1 MiB cap, regular-file check, per-field type and range checks, root allow-list on the resolved real path, freshness check against the run start. Anything that fails is ignored. |
| A planted `result.json` from a local process that can write in a temp folder | It could write a `result.json` that matches a pending run and attach false numbers (status, tokens, cost) to it. Mitigations: pairing only when the start is between 5 s before and 60 s after the run started, tool and working-directory match wherever both are known, freshness check against the run start, regular file and no links, 1 MiB cap, per-field type and range checks, and only allow-listed fields are kept. Residual risk: such a process can still spoof the numbers watchducks shows for a relay. This is display only: nothing is executed and no content is shown. |
| A planted child report from a local process that can write in the temp dir | It could write a report in the parent's folder that matches a pending run and attach false numbers (usage, cost, status) to it. Mitigations: the folder is named by a hash of the parent's session id, and only the parent's own folder is read; a report matches only when its start is between 5 s before and 60 s after the run started, its folder and model agree wherever the run knows them, and each report goes to one run; schema check, 64 KiB cap, regular file, no links, real path inside the temp root, per-field type and range checks, a 24 h freshness check, and only allow-listed fields kept. A model counts as known only when it is a full id (`claude-…`); an alias such as `sonnet` counts as unknown. Residual risk: such a process can still spoof the numbers shown for a run. This is display only: nothing is executed and no content is shown. |
| A fake `opencode` on PATH | `opencode stats` runs with the user's own rights, as any CLI the session runs does. Nothing runs unless `opencodeStats` is on. Its output passes the same numeric allow-list as the real output, with the caps above: only the listed values are read, and stdout over 1 MiB is ignored. |
| Other plugins reading state | State holds only allow-listed values. |
| Price-table drift | The table is dated, can be overridden with `priceOverrides`, and a cost reported by a relay is preferred over an estimate (in `auto` mode). Unknown models show "?" and are never given a default price. |
| A tampered or broken price list | The list comes from a fixed `https` URL, fetched through the Claude Code host. It is capped at 8 MiB and projected to four numbers per chat model, with the caps listed under Price refresh; a list with fewer than 100 valid entries is ignored. The stored record is checked field by field when it is read. The Claude table and `priceOverrides` win over the list. Residual risk: wrong estimates for non-Claude models. This is display only: nothing is executed and no content is shown. |
| Store growth | 30-day pruning and a cap of 200 records. |

## Residual risks

- **Stat-then-read race.** watchducks checks the file with a stat, then reads it. A file swapped between the two could be read once. Its content still goes through the same projection, so only allow-listed fields are kept.
- **Whole file in memory.** result.json, including `finalMessage`, is in memory for one parse.
- **State is readable by other plugins.** Values in state are allow-listed, but they are not secret from other installed plugins.
- **Discovery reads folder names.** While a relay runs without an `--out-dir`, discovery reads the names of folders in the allowed roots. The names are read transiently and never stored.
- **Large folders are listed in full.** The engine's folder listing has no limit, so discovery receives a folder's whole listing before it keeps the first 2048 entries. A folder with a very large number of entries in an allowed root makes one discovery pass slower. Each pass also stops after about 2 seconds.
- **A folder swapped during a pass.** Between the check that a folder is a real folder and its listing, a local process could swap it for a link, and discovery would read the names in the folder the link points to. Names are not stored, and a result.json is read only if its resolved path is inside an allowed root.
- **Results rewritten in old folders are not found.** Discovery looks only in folders created or changed since the run started. A relay that rewrites a result.json inside an older folder, without `--out-dir`, is not found. Relays that create a new folder per run, and any run given `--out-dir`, are not affected.
- **Report files stay on disk.** Child report files stay until the OS temp cleanup removes them, because watchducks has no delete. Readers ignore a report whose `updatedAt` is older than 24 h.
- **A report file swapped before its read.** Between the check on a report file and its read, the file can be swapped for a link or a FIFO. The engine caps reads at 4 MiB, and it has no no-follow read.
- **Report folder checked before each write.** A child checks that its report folder is a directory inside the temp root, not a link, before each write. The engine has no no-follow write, so that check cannot be made atomic with the write.
- **Stats baseline race.** A run's first stats snapshot can be taken after the run has started. Its figures are exact only when that snapshot is requested no later than 1.5 s after the run's start; otherwise they are approximate.
- **`Run.workdir` is in memory only.** The normalized working directory of a run (`Run.workdir`) lives only in the in-memory ledger, like the relay `outDir`. The stats process needs it as its working directory. It is never written to history or the store, logged, toasted or rendered.
- **Late starts are not matched.** A result is paired with a run only when its start is between 5 seconds before and 60 seconds after the Bash call. A relay started later in the same command (for example after `sleep 90`) is not found by discovery; pass `--out-dir` for such commands.

## Mod standards

- Observer hooks on tools pass the call through unchanged and fail open: if watchducks fails, the call proceeds as if watchducks were not installed.
- The only hooks that answer tool calls are watchducks' own two tools, `mcp__watchducks__roster` and `mcp__watchducks__verdict`.
- CI compares the gating hooks reported by the engine with `test/gating-allowlist.json` and fails on any difference. There are 11 gating hooks, and the allow-list is unchanged in v0.2.
