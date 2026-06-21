# Local quality gates: commit hooks, pre-push, CI parity

Status: designed, not wired.
Vocabulary follows [CONTEXT.md](../../../CONTEXT.md).

## Decision

Use Lefthook for checked-in Git hook orchestration, Turborepo for package-aware task execution,
Biome for lint/format, TypeScript for type checks, Knip for unused files/exports/dependencies,
Gitleaks for secret scanning, dependency-cruiser for architecture boundaries, and Vitest for tests.

The local hooks are not a replacement for CI. They are the first failure surface so agents and humans
catch ordinary failures before pushing.

## Required scripts

Once the package scaffold lands, the root `package.json` should expose these scripts:

| Script | Command contract |
|---|---|
| `format:check` | `biome format --check .` |
| `format:write` | `biome format --write .` |
| `lint` | `turbo run lint` |
| `typecheck` | `turbo run typecheck` |
| `test` | `turbo run test` |
| `build` | `turbo run build` |
| `depcruise` | `dependency-cruiser --config .dependency-cruiser.cjs "apps/**/*.{ts,tsx}" "workers/**/*.{ts,tsx}" "packages/**/*.{ts,tsx}"` |
| `knip` | `knip` |
| `secrets:worktree` | `gitleaks dir --redact --no-banner .` |
| `secrets:git` | `gitleaks git --redact --no-banner .` |
| `verify:commit` | commit hook entrypoint |
| `verify:push` | pre-push and local CI-parity entrypoint |
| `verify:ci` | CI entrypoint |

`verify:ci` and `verify:push` must stay aligned. The only required difference is that `verify:push`
does not run hosted smoke tests or any command that mutates Cloudflare, Tinybird, GitHub
deployments, or secrets.

## Hook policy

`pre-commit` blocks bad commits:

- Run `format:check`, `lint`, and `typecheck`.
- Run `knip` after generated files needed for module graph discovery exist.
- Run `secrets:worktree` or the official Gitleaks pre-commit integration before the commit is written.
- Prefer affected/scoped Turbo execution where it is sound. Fall back to the full task when the base
  commit is unavailable or the change touches shared config.

`pre-push` mirrors CI without smoke tests:

- Run the same validation sequence as `verify:ci`: format check, lint, typecheck, tests, build,
  dependency-cruiser, Knip, Gitleaks, local D1 migrations, and Tinybird Local validation.
- Skip only hosted smoke checks, shared-preview deploy/reset, production deploy, rollback, and other
  remote-state mutations.
- Use Turborepo remote cache when `TURBO_TOKEN` and `TURBO_TEAM` are available; local cache is still
  valid when those values are absent.

Agents should treat a CI failure as a local reproduction task first. Pull the failing check name,
run the matching root script locally, fix the failure, and rerun `verify:push` before handing work back.

## CI policy

The required CI check runs on Blacksmith and executes `verify:ci`. It includes everything in
`verify:push`, plus hosted smoke checks where the workflow has trusted credentials and an appropriate
platform target.

Gitleaks also runs as its own required CI workflow so secret scanning remains visible even if the JS
toolchain is broken.

## Knip policy

Knip is required in commit, pre-push, and CI gates once the workspace has real entrypoints.

- Start with explicit `entry` and `project` patterns for `apps/**`, `workers/**`, and `packages/**`.
- Fix Knip findings in this order: unused files, unresolved imports, unused exports, unused
  dependencies.
- Use `ignore*` options only when the entry graph is correct and the ignore has a reason.
- Generated route files, OpenAPI artifacts, and Worker bundles must be generated before Knip when Knip
  needs them to resolve the graph.

## Gitleaks policy

Gitleaks is required in commit, pre-push, and CI gates.

- Commit-time scanning blocks newly introduced secrets before the commit is written.
- Pre-push scanning catches committed secrets before they leave the workstation.
- CI runs a full git scan and uploads redacted output only.
- False positives go in `.gitleaks.toml` allowlists with a short reason. Do not hide findings with an
  unexplained ignore file.
- The repo should use `gitleaks git` and `gitleaks dir`; older hidden `detect` and `protect` commands
  are not the documented interface.

## First implementation checklist

- Add `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `turbo.json`, `biome.json`,
  `knip.json`, `.gitleaks.toml`, and `lefthook.yml`.
- Add package-level `lint`, `typecheck`, `test`, and `build` scripts.
- Add root `verify:commit`, `verify:push`, and `verify:ci` scripts.
- Install Lefthook during setup and document `pnpm lefthook install`.
- Wire CI to call `pnpm verify:ci` and the pre-push hook to call `pnpm verify:push`.
- Keep remote-mutating smoke/deploy steps outside commit and pre-push hooks.

## Sources

- Turborepo CI, task cache, and environment variable docs:
  <https://turborepo.dev/docs/crafting-your-repository/constructing-ci>,
  <https://turborepo.dev/docs/reference/configuration>,
  <https://turborepo.dev/docs/crafting-your-repository/using-environment-variables>
- Lefthook docs:
  <https://lefthook.dev/>
- Knip docs:
  <https://knip.dev/>,
  <https://knip.dev/guides/handling-issues>
- Gitleaks docs:
  <https://github.com/gitleaks/gitleaks>
