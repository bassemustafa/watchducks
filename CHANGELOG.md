# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-14

### Added

- Sidebar (docked beside a fullscreen transcript) and inline band showing every operative: subagents, claude, opencode and codex delegate relays, other CLI agents, and background shells started by the session.
- Per run: status, implementer, model, effort, tokens (uncached, output, cache read, cache write), cost with its source (reported or estimated), edits, and bugs found by reviewers.
- Dossier view for one run, and a station board grouped by implementer and model, for this session or the last 30 days.
- `/flock`, `/flock station`, `/flock clear` and `/flock purge` commands, and the `verdict` and `roster` tools.
- Pixel-art duck and radar animation in the terminal, and SVG views in the desktop app. `motion` and `glyphs` settings.
- Delegate relay `result.json` projection, keeping allow-listed fields only, with path, size and freshness checks.
- Price table dated 2026-10-06, with `priceOverrides`.
- CI: validate, gating-hook allow-list check and tests on Claude Code 2.1.295.

[Unreleased]: https://github.com/bassemustafa/watchducks/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bassemustafa/watchducks/releases/tag/v0.1.0
