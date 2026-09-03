# Local quality gates: commit hooks, pre-push, CI parity

Status: implemented; build-fast exceptions are listed below.
Vocabulary follows [CONTEXT.md](../../../CONTEXT.md).

> **Build-fast phase — what is actually enforcing right now.** The full gate set below is the
> **target** posture. While we are building toward a final dependency tree, the gates that fail on
> things unrelated to the work in flight are **parked** so agents ship instead of chasing dependency
> noise. This is deliberate and tracked here as the single source of truth; re-enabling is one
> explicit lockdown milestone (a launch prerequisite, see [ADR-0035](../../adr/0035-security-automation-and-supply-chain-integrity-are-an-enforced-ci-contract.md)),
> not per-PR work.
>
> **Enforcing now (deterministic, your-code-only):** `format:check`, `lint` (including
> `@splitch/repo-lint` workspace publishing policy), `typecheck`, `knip`, `gitleaks` — locally
> (commit + pre-push) and in CI. Plus `test` + `build` in CI.
>
> **Parked until lockdown:**
>
> | Parked gate                                                         | Where it was             | How to restore                                 |
> | ------------------------------------------------------------------- | ------------------------ | ---------------------------------------------- |
> | `pnpm audit` (dep CVEs)                                             | `verify:*`               | add back to `verify:ci`                        |
> | Semgrep SAST (`sast`)                                               | `verify:*`               | add to `verify:ci`                             |
> | `pinact -check` (`pins:check`)                                      | `verify:*`, `ci.yml`     | add to `verify:ci`; restore CI install step    |
> | CodeQL                                                              | `codeql.yml`             | flip triggers to `pull_request`/`push`         |
> | OSV-Scanner / Trivy / Scorecard merge gates                         | pull requests and pushes | add PR/push triggers after dependency lockdown |
> | pnpm install quarantine (`minimumReleaseAge`, `blockExoticSubdeps`) | `pnpm-workspace.yaml`    | uncomment the four keys                        |
> | smoke / depcruise / jscpd in pre-push                               | `verify:push`            | restore at the lockdown milestone              |
>
> The `security:full` script still runs the SAST + pin + audit + secret battery on demand. The rest of
> this file describes the **target** gates; treat the table above as the current reality where they differ.
> Dependency-cruiser is enforced in CI; its pre-push invocation remains parked with the other
> heavier local gates.

## Decision

Use Lefthook for checked-in Git hook orchestration, Turborepo for package-aware task execution,
Biome for lint/format, TypeScript for type checks, Knip for unused files/exports/dependencies,
jscpd for duplicate-code detection, Gitleaks for secret scanning, dependency-cruiser for architecture
boundaries, and Vitest for tests.

The local hooks are not a replacement for CI. They are the first failure surface so agents and humans
catch ordinary failures before pushing.

## pnpm supply-chain policy

**Parked in the build-fast phase** (commented out in `pnpm-workspace.yaml`): these reject `pnpm
install` on a freshly published or non-registry transitive — dependency churn unrelated to the work
in flight. The lockdown milestone uncomments all four keys. The target policy:

- `minimumReleaseAge: 4320` requires package versions to be at least 3 days old before install.
- `minimumReleaseAgeStrict: true` fails resolution instead of falling back to immature versions.
- `minimumReleaseAgeIgnoreMissingTime: false` fails packages whose registry metadata omits publish time.
- `blockExoticSubdeps: true` blocks transitive dependencies from using untrusted exotic sources such as
  git URLs or direct tarball URLs.

Do not add `minimumReleaseAgeExclude` entries as a convenience path. Security fixes can use a narrowly
reviewed exception, but normal tool upgrades wait until the package version satisfies the 3-day policy.

## Required scripts

The root `package.json` exposes these scripts:

| Script                 | Command contract                                                   |
| ---------------------- | ------------------------------------------------------------------ |
| `format:check`         | `biome format . && prettier --check "**/*.md"`                     |
| `format:write`         | `biome format --write . && prettier --write "**/*.md"`             |
| `lint`                 | `turbo run lint` (includes `@splitch/repo-lint` publishing policy) |
| `typecheck`            | `turbo run typecheck`                                              |
| `test`                 | `turbo run test`                                                   |
| `build`                | `turbo run build`                                                  |
| `dev:api`              | API/MCP Worker local dev set on stable ports                       |
| `smoke:local`          | local Wrangler smoke for selected Workers                          |
| `smoke:local:api`      | local Wrangler smoke for API/MCP Workers                           |
| `shared-preview:smoke` | hosted shared-preview route, auth, MCP, and binding smoke          |
| `depcruise`            | `dependency-cruiser --config .dependency-cruiser.cjs`              |
| `duplicates`           | `jscpd --config .jscpd.json --exit-code`                           |
| `knip`                 | `knip --treat-config-hints-as-errors`                              |
| `secrets:staged`       | `gitleaks git --redact --no-banner --staged .`                     |
| `secrets:range`        | scan only the change's commit range (CI/pre-push)                  |
| `secrets:git`          | `gitleaks git --redact --no-banner .` (full history)               |
| `verify:commit`        | commit hook entrypoint                                             |
| `verify:push`          | pre-push and local CI-parity entrypoint                            |
| `verify:ci`            | CI entrypoint                                                      |

Root scripts own repository-wide static analysis commands that do not belong to one runtime package.
Biome formats code/config. Prettier formats Markdown only.

`verify:push` is the lean local graph: format, lint, typecheck, Knip, the exact commit-range secret
scan, and the local Tinybird and D1 validators. `verify:ci` owns the full test, build, documentation,
contract, statistics, and dependency-cruiser graph. The required CI workflow selects the local
Tinybird and D1 validators from its changed-path plan. Neither command runs hosted smoke tests or
mutates hosted Cloudflare, Tinybird, GitHub deployment, or secret state. Local Worker smoke remains
an explicit command described in [agent-verification.md](./agent-verification.md).

## Hook policy

`pre-commit` blocks bad commits:

- Run `format:check`, `lint`, and `typecheck`.
- Run `knip` after generated files needed for module graph discovery exist.
- Run `secrets:staged` (Gitleaks over staged changes) before the commit is written.
- Prefer affected/scoped Turbo execution where it is sound. Fall back to the full task when the base
  commit is unavailable or the change touches shared config.

`pre-push` mirrors CI without smoke tests:

- **Build-fast phase:** `verify:push` runs the lean static set (format check, lint, typecheck, Knip,
  Gitleaks) plus the real local D1 migration gate (`d1:migrate:local`, SPL-9). The fuller sequence
  below is the target once the app exists.
- **Target sequence** (restored at lockdown / as apps and migrations land): format check, lint,
  typecheck, tests, build, local API Worker smoke, dependency-cruiser, jscpd, Knip, Gitleaks, local D1
  migrations, and Tinybird Local validation.
- Skip only hosted smoke checks, shared-preview deploy/reset, production deploy, rollback, and other
  remote-state mutations.
- Use Turborepo remote cache when `TURBO_TOKEN`, `TURBO_TEAM`, and
  `TURBO_REMOTE_CACHE_SIGNATURE_KEY` are available. Remote cache artifact signing is enabled, and
  local cache is still valid when those values are absent.

Agents should treat a CI failure as a local reproduction task first. Pull the failing check name,
run the matching root script locally, fix the failure, and rerun `verify:push` before handing work back.

## CI policy

The required CI check runs on Blacksmith and executes the affected `verify:ci` graph, including
dependency-cruiser over the repository's app and package sources. The workflow
adds `tinybird:local`, `d1:migrate:local`, and `d1:migrate:populated` when their inputs change;
missing comparison evidence fails closed to all three validators and the full, still cache-first,
graph (only `nightly-verify` runs uncached). Hosted
smoke checks run in trusted deploy workflows where the target has just been updated.

Gitleaks runs as a dedicated step in the `ci` workflow (`secrets:range`), before `verify:ci`, scoped
to the change's commit range rather than the whole tree. It is a separate step (not folded into
`verify:ci`) so a secret-scan failure is attributable on its own and the CI runner installs the
`gitleaks` binary that `verify:ci` does not require.

## Knip policy

Knip is required in commit, pre-push, and CI gates.

- Let Knip infer pnpm workspaces unless a package needs an explicit override; config hints are errors.
- Fix Knip findings in this order: unused files, unresolved imports, unused exports, unused
  dependencies.
- Use `ignore*` options only when the entry graph is correct and the ignore has a reason.
- Generated route files, OpenAPI artifacts, and Worker bundles must be generated before Knip when Knip
  needs them to resolve the graph.

## Duplicate-code policy

jscpd is available through `pnpm duplicates`. It is not part of pre-push or CI during the
build-fast phase; the lockdown milestone restores it as a required gate.

- Scan source-bearing paths only: `apps`, `packages`, and `scripts`.
- Keep docs out of the duplicate-code gate. Specification files intentionally repeat canonical terms
  and cross-references.
- Keep the threshold at `0` so any detected source clone fails the gate.
- Fix findings by extracting the shared capability, narrowing an over-broad scaffold, or adding a
  narrowly justified ignore when the repetition is not executable source behavior.

## Gitleaks policy

Gitleaks is required in commit, pre-push, and CI gates.

- Commit-time scanning blocks newly introduced secrets before the commit is written.
- Pre-push scanning catches committed secrets before they leave the workstation.
- CI scans the exact commit range and emits redacted output only. `pnpm secrets:git` is the explicit
  full-history audit.
- False positives use exact fingerprints in `.gitleaksignore`, grouped under a short reason. Do not
  add unexplained or path-wide exclusions.
- The repo should use `gitleaks git` and `gitleaks dir`; older hidden `detect` and `protect` commands
  are not the documented interface.

## D1 and Tinybird local policy

`pnpm d1:migrate:local` and `pnpm tinybird:local` are wired into `verify:push`. The `ci` workflow
runs them conditionally from its exact changed-path plan rather than placing them in every
`verify:ci` invocation.

`pnpm d1:migrate:local` is now a real failing validator (SPL-9): committed `@splitch/db` Drizzle
migrations exist, so it runs `wrangler d1 migrations apply --local` against a fresh local Miniflare D1
and exits non-zero on a malformed/duplicate-column migration. It is no longer a best-effort skip.

`pnpm tinybird:local` is a real failing validator for committed Tinybird project files under
`infra/tinybird`. It generates throwaway Tinybird Local user/workspace tokens, starts a disposable
Local container with those tokens, runs `tb build` using `tinybird.config.json` (`dev_mode=local`),
runs Tinybird tests when test files exist, and removes the Local container in cleanup. This avoids
the shared default Tinybird Local user accumulating workspaces across agent runs.

## Local Worker smoke policy

`pnpm smoke:local:api` is the first HTTP-level proof for API/MCP Workers. It builds the selected
workspace graph, starts each Worker with `wrangler dev --local` on its stable port, calls `/`, checks
the response, and stops the Worker.

Stable local ports:

| Worker                   | Port |
| ------------------------ | ---- |
| Control Plane API Worker | 8787 |
| Evaluation Worker        | 8788 |
| Event Ingest Worker      | 8789 |
| Analysis Worker          | 8790 |
| Auth API Worker          | 8791 |
| MCP Worker               | 8792 |
| Control Panel Worker     | 8793 |
| Marketing Worker         | 8794 |

New HTTP route slices must add a route-specific local proof instead of relying only on the baseline
health smoke.

## Implementation checklist

- [x] Add `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `turbo.json`, `biome.json`,
      `knip.json`, `.gitleaks.toml`, and `lefthook.yml`.
- [x] Add package-level `lint`, `typecheck`, `test`, and `build` scripts.
- [x] Add stable local dev ports for Worker packages and `dev:api`.
- [x] Add root `verify:commit`, `verify:push`, and `verify:ci` scripts.
- [ ] Wire local API Worker smoke into `verify:push` and `verify:ci` at the lockdown milestone.
- [ ] Wire jscpd duplicate-code detection into `verify:push` and `verify:ci` at the lockdown milestone.
- [x] Install Lefthook during setup through `prepare`.
- [x] Wire CI to call `pnpm verify:ci` and the pre-push hook to call `pnpm verify:push`.
- [x] Keep remote-mutating smoke/deploy steps outside commit and pre-push hooks.
- [x] Replace the D1 skip guard with a real validator (SPL-9: `@splitch/db` migrations + real
      `wrangler d1 migrations apply --local`).
- [x] Replace the Tinybird skip guard with a real validator for `infra/tinybird` project files.

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
- jscpd docs:
  <https://github.com/kucherenko/jscpd>
