# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/bassemustafa/watchducks/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bassemustafa/watchducks/releases/tag/v0.1.0
