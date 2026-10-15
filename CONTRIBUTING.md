# Contributing to watchducks

Thanks for helping. Keep changes small and focused.

## Before you start

- For a feature, open an issue first and describe the problem. Wait for agreement before you write code.
- Bug fixes can go straight to a pull request. Link the issue if one exists.
- Read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). All participants are expected to follow it.
- Do not report security problems in issues or pull requests. Follow the process in [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node 20 or newer for development (CI uses Node 24), and Claude Code 2.1.289 or newer. CI runs the tests on 2.1.289 and 2.1.295; a Button takes only a plain string `label`, because 2.1.289 refuses any other content.

From the repo root:

```sh
npm ci
claude --plugin-dir .    # run Claude Code with the local mod loaded
```

All four gates must pass before you open a pull request:

```sh
claude plugin validate .
npx tsc -p .
claude plugin test .
npm run check:gating
```

Type checking needs the engine's type declarations. Start `claude --plugin-dir .` once: Claude Code writes them into `.claude-plugin/types/`, which is gitignored and never committed. CI has no copy of them, so it does not run `tsc`; run it locally before every pull request.

## Project layout

- `hooks/register.tsx`: plugin entry point.
- `src/`: lifecycle, collectors under `src/collect/`, usage adapters under `src/adapters/`, pure ledger, price, cost, classify and history modules, and UI under `src/ui/`.
- `src/prices-litellm.ts`: the bundled LiteLLM price list. It is generated; do not edit it by hand.
- `types/index.d.ts`: the shared data contract.
- `test/`: engine tests. `test/unit/`: pure tests.
- `scripts/check-gating.mjs`: gating hook check.
- `scripts/update-prices.mjs`: regenerates `src/prices-litellm.ts` from LiteLLM's public price list.
- `test/gating-allowlist.json`: the allow-list of gating hooks that CI checks.

## Engine rules

The mod engine enforces these rules. Breaking one either fails the load or silently skips a hook.

1. Pass the `$` engine handle only to functions declared in the same file. Never pass it to an imported function.
2. Register each event at most once without a matcher. `session.start` and `session.end` live in `src/lifecycle.ts`. `agent.spawn`, `turn.step`, `turn.complete`, `classic.Stop` and `classic.SubagentStop` live in `src/collect/agents.ts`.
3. Declare state atoms in each file that uses them, with the literal plugin and key. Never import them.
4. Engine tests must raise events with their full input shape. To check for skipped hooks, run `claude --debug plugin test . | grep -i skipped`.

## Privacy rules

This is the core promise of the project, and it is not negotiable.

watchducks never reads, copies, displays, logs or stores message content, prompts, tool input or output text, file contents, or error text. It keeps only allow-listed metadata: ids, model, effort, token counts, cost, status, timings and counts. The files it reads are a delegate relay's `result.json` and the numbers-only reports of child Claude sessions. It reads them transiently and keeps only allow-listed fields. With the `opencodeStats` setting on, it runs `opencode stats` with a fixed argument list and keeps only the numbers.

Check every change that touches collectors against this list:

- [ ] It does not read message, prompt, tool input or output, or file content.
- [ ] It does not add a new content field to the data contract in `types/index.d.ts`.
- [ ] It does not store or log anything beyond allow-listed metadata.
- [ ] It adds no network call. The only one is the daily price list GET in `src/lifecycle.ts`, which sends no data.
- [ ] `test/privacy.test.ts` still passes. Do not weaken or remove the canary test.
- [ ] Any new gating hook is added to `test/gating-allowlist.json`, and the pull request says why. Reviewers check each entry.

## Pull requests

- Keep one change per pull request.
- All four gates must be green.
- Add tests for new behavior.
- Update `CHANGELOG.md` under `## [Unreleased]`.
- Use conventional commit style, for example `feat(ui): ...`, `fix(collect): ...` or `docs: ...`.
- Claude prices come from the built-in table in `src/price.ts`, dated 2026-10-06. Any change to that table needs a source link in the pull request. Prices for other models come from LiteLLM's list; do not edit `src/prices-litellm.ts` by hand.
- Fill in the pull request template.

## Releasing

For maintainers, before the version bump:

1. Refresh the bundled price list: `node scripts/update-prices.mjs`. It writes `src/prices-litellm.ts` with today's date.
2. Run the four gates. The test `common agent models keep a price in the bundled list` fails when a common model lost its price or moved to another LiteLLM entry; update its list in `test/unit/price-list.test.ts` after checking the new entry.
3. Bump the version in `.claude-plugin/plugin.json`, `package.json` and `package-lock.json`, and move `## [Unreleased]` in `CHANGELOG.md` under the new version.

## License

watchducks is released under the MIT License. See [LICENSE](LICENSE). By contributing, you agree that your contributions are licensed under the MIT License.
