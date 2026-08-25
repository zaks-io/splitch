# Contributing to splitch

Thanks for looking. splitch is pre-1.0 and moving quickly, so the most useful thing you can
do is tell us what broke.

## Reporting a bug

Open a [GitHub issue](https://github.com/zaks-io/splitch/issues). What helps most:

- The component and version: `@splitch/sdk`, `@splitch/cli`, `@splitch/convex`, the CLI, the
  MCP server, the control panel, or a commit SHA.
- The stable error code, if you got one. Every failure carries one, and each has a page at
  `https://splitch.dev/docs/error/{code}`.
- What you expected versus what happened, and the smallest way to reproduce it.

Never put a Client Key, API Key, or session token in an issue. Redact them.

**Security vulnerabilities do not go in a public issue.** See [`SECURITY.md`](SECURITY.md)
for the private disclosure path.

## Proposing a change

Open an issue before writing code for anything beyond a typo or an obvious fix. The domain
model and the public contracts are settled deliberately, and the fastest way to have a pull
request rejected is for it to introduce a second way to do something that already works. A
short issue first saves you the round trip.

## Working in the repo

Requires **Node.js 20+** and **pnpm 11.8** (`corepack enable` picks up the pinned version).

```bash
pnpm install     # also installs the Lefthook git hooks
pnpm dev         # every Worker (wrangler) and frontend (vite), in parallel
pnpm test        # the full test suite
pnpm verify:push # the full local gate
```

Before you write code, read two documents:

- [`CONTEXT.md`](CONTEXT.md) — the glossary. Flag, Variant, Run, Exposure, Targeting Key, and
  Environment each mean one specific thing here, borrowed from OpenFeature and the standard
  experimentation vocabulary. Use those terms exactly and do not invent synonyms.
- [`docs/vision.md`](docs/vision.md) — what the project is for. When a design decision is
  ambiguous, resolve it toward that document.

Two house rules that reviewers will hold you to:

- **Fail loud.** Never substitute a plausible default for missing or broken data. Populate it
  or throw. A wrong value that looks right costs more than a crash.
- **One way to do a thing.** Extend the existing mechanism rather than adding a parallel one
  next to it.

## Pull requests

- Branch off `main`. Keep the change focused on one thing.
- `pnpm verify:push` must pass locally, and CI must be green. Do not bypass a failing gate:
  no `--no-verify`, no ad-hoc flags to coax a command into passing. If a hook fails on code
  you did not touch, check whether your branch has drifted from `main`.
- Add tests for behavior you change. A test that would still pass with the fix reverted is
  not a test.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat(control-panel): …`, `fix(sdk): …`, `docs: …`). Pull requests are squash-merged, so
  the title becomes the commit message.
- If your change touches a public surface (the SDK, the CLI, the MCP tools, or an error
  code), update the docs in the same pull request. The specs under [`docs/spec/`](docs/spec/)
  are the source of truth, not an afterthought.

## Working with coding agents

This repo is built to be worked on by agents as well as people. [`AGENTS.md`](AGENTS.md) is
the entry point they read: it points at the vision, the glossary, and the workflow skills.
If you use an agent here, point it there first.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE.md), the same license that covers the project.
