# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- HQ (the main loop) is an operative: its own card, first under OPERATIVES, with model, effort, time since the session started, tokens and cost (no status words, since it never ends), and a dossier with its models, effort, token breakdown, cache hit and cost. Signal's tokens, tok/min, cache, spend and the per-implementer split now include HQ; the station board and the 30-day history count its spend in the `claude-code · <model>` rows like any Claude model (as spend, not as ops); the `roster` tool lists it first. The dim HQ line under Signal is gone.

### Fixed

- Background shells (a command started with `run_in_background`, such as `sleep 40` or an `opencode run`) now end DEBRIEFED, WENT DARK or BURNED, from the status their task notification reports, instead of RETURNED (outcome unknown). Only the status and ids are read, never the notification's text. RETURNED remains for a task whose notification is never drawn.

### Changed

- README: a recorded demo, a sidebar clip and the station board, a how-it-works diagram, and a plain explanation of delegate relays with a 12-line example. The reference sections are collapsible.
- Contributing: issue forms (bug, feature, new agent CLI, question), a labelled triage flow, a PR template with type and testing sections, and automatic area labels on pull requests.

## [0.2.1] - 2026-10-15

### Fixed

- Models used through a provider that LiteLLM does not list, such as opencode's `opencode-go`, are now priced from their maker's own entry (for example GLM from `zai`, Qwen from `dashscope`, Kimi from `moonshot`) instead of showing no estimate or a reseller's price.

### Changed

- The bundled LiteLLM price list is refreshed to 2026-10-15.

## [0.2.0] - 2026-10-14

### Added

- opencode stats adapter, opt-in with the `opencodeStats` setting (default off): opencode runs get live token and cost numbers from `opencode stats`. Runs of the same model in one folder that are active together share their numbers evenly, and are marked approximate.
- Claude child reports, on by default with `reportToParent`: a Claude Code session started by another Claude Code session writes numbers-only progress for its parent, and the parent shows it live on the matching card. Live numbers arrive about every 5 s for Claude children and about every 10 s for opencode runs (with `opencodeStats` on).
- Terminal motion, with the `motion` setting: pulsing status dots on running cards, a stamp when a run ends (DEBRIEFED, WENT DARK or BURNED), a token and cost ticker, and a blinking duck while runs are in field. The desktop app and the band do not animate.
- Cost estimates for any model: when no real cost is reported, tokens are priced from LiteLLM's model price list, after `priceOverrides` and the Claude table. The `costMode` setting (`auto`, `estimate` or `reported`) sets when an estimate is used; estimates are marked `est.`.
- Daily price refresh, on by default with the `priceUpdates` setting: one GET to LiteLLM's public price list on GitHub, at most once a day. `off` uses the price list bundled with this version.

### Changed

- The privacy rules now allow one fixed process, `opencode stats`, only when `opencodeStats` is on, and writes of child report files, on by default with `reportToParent`. Both are described in the README's Privacy section and in SECURITY.md.
- The privacy rules now allow one network request, the daily price refresh (`priceUpdates`, on by default). It is described in the README's Privacy section and in SECURITY.md.
- A reported cost of $0 with tokens (for example, a model used through a subscription) now shows an estimate marked `est.` in the default `costMode` `auto`, instead of `$0 reported`. `costMode` `reported` keeps the v0.1 behaviour.

## [0.1.0] - 2026-10-12

### Added

- Sidebar (docked beside a fullscreen transcript) and inline band showing every operative: subagents, claude, opencode and codex delegate relays, other CLI agents, and background shells started by the session.
- Per run: status, implementer, model, effort, tokens (uncached, output, cache read, cache write), cost with its source (reported or estimated), edits, and bugs found by reviewers.
- Dossier view for one run, and a station board grouped by implementer and model, for this session or the last 30 days.
- `/flock`, `/flock station`, `/flock clear` and `/flock purge` commands, and the `verdict` and `roster` tools.
- Pixel-art duck and radar animation in the terminal, and SVG views in the desktop app. `motion` and `glyphs` settings.
- Delegate relay `result.json` projection (schema `delegate-relay.result.v<N>`), keeping allow-listed fields only, with path, size and freshness checks.
- General relay detection (any `relay*` script or one under a `*delegate*` folder; chains, pipes and wrappers) and automatic result.json discovery when `--out-dir` is not given.
- Input token totals in the dossier, and an input/output and cache split per station board row.
- Price table dated 2026-10-06, with `priceOverrides`.
- CI: validate and tests on Claude Code 2.1.289 (the desktop app's engine) and 2.1.295, plus the gating-hook allow-list check on 2.1.295.

[Unreleased]: https://github.com/bassemustafa/watchducks/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/bassemustafa/watchducks/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/bassemustafa/watchducks/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bassemustafa/watchducks/releases/tag/v0.1.0
