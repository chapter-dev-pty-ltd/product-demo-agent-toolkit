# AGENTS.md

## Comments

- Never write comments that say what code does or how; agents read that from the code.
- Comment only what the code can't tell a reader, briefly:
  - Why it diverges from a rule, spec or convention set elsewhere (a lint rule, the formatter, this file, a paper it implements).
  - Behaviour outside the repo that it works around (a tool, platform, API or site).
  - Where a pinned or tuned value came from (a version, a hash, a measured timing).
- The test: would someone "simplify" the code into a bug without the comment? If not, leave it out.

## Tests

- Avoid useless or bloated tests. Models default to adding lots of tests, and they rarely add value.
- Before adding one, ask: does it test the crux of the system, or is it bloat?
- Test what's subtle and easy to break unnoticed (a rule, an edge case, a contract), not what the types or a glance at the code already guarantee.
- Prefer one test that pins down the core behaviour over several that restate it.

## Pull requests

- Prefer shorter PR descriptions that note, at a high level, the why of a change, not so much the how.
