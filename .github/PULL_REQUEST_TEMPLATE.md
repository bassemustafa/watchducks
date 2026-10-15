## Type

- [ ] Bug fix
- [ ] Feature
- [ ] Docs
- [ ] Chore
- [ ] Tests

## Summary

## Linked issue

Closes #

## How I tested it

## Checklist

- [ ] All four gates pass: `claude plugin validate .`, `npx tsc -p .`, `claude plugin test .`, `npm run check:gating`
- [ ] Tests added or updated for new behavior
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`

### Privacy

- [ ] No new reads of message, prompt, tool input or output, or file content
- [ ] No new stored or logged fields beyond allow-listed metadata
- [ ] No new network calls (the daily price list GET is the only one)
- [ ] `test/privacy.test.ts` passes
- [ ] Any new gating hook is in `test/gating-allowlist.json`, with the reason given in the summary

### Engine rules

- [ ] `$` is not passed to imported functions
- [ ] Each event is registered at most once without a matcher
- [ ] State atoms are declared in each file that uses them

> 🦆 The flock watches the runs, never the words.
