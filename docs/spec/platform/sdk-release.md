# SDK release runbook: `@splitch/sdk` public npm path

Status: release path specified in [SPL-125](https://linear.app/zaks-io/issue/SPL-125); workflow
implementation tracked in [SPL-129](https://linear.app/zaks-io/issue/SPL-129) (draft release) and
[SPL-130](https://linear.app/zaks-io/issue/SPL-130) (trusted npm publish). This document is the
maintainer and agent runbook; live provider-setup completion is tracked on the owning Linear tickets,
not a parallel setup doc.

Parent spec: [SPL-125](https://linear.app/zaks-io/issue/SPL-125). Supply-chain posture:
[ADR-0035](../../adr/0035-security-automation-and-supply-chain-integrity-are-an-enforced-ci-contract.md).

## Decision

`@splitch/sdk` is the only publishable workspace package. First public version is `0.1.0` with npm
dist-tag `latest`. Release is a two-step, human-gated path:

1. **Draft release prep** — maintainer manually dispatches `sdk-release`; Blacksmith validates the
   candidate and creates or updates a **draft** GitHub Release.
2. **Trusted npm publish** — maintainer publishes the GitHub Release; `sdk-publish` runs on
   GitHub-hosted infrastructure and is the **only** path to npm.

Push tags alone do **not** publish to npm. Publishing a GitHub Release is the sole npm trigger.

## Version source of truth

`packages/sdk/package.json` `version` is the only release version input. Workflows derive the GitHub
tag from that field; maintainers do not type versions into workflow inputs or create tags by hand.

Tag namespace: `sdk-v{version}` — for example `sdk-v0.1.0` for version `0.1.0`.

## Workflows

| Workflow file                       | Trigger                                                  | Runner                                                            | Result                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/sdk-release.yml` | `workflow_dispatch` only                                 | Blacksmith (`blacksmith-2vcpu-ubuntu-2404` or larger if measured) | Validates SDK candidate; creates or updates a **draft** GitHub Release for `sdk-v{version}`; uploads review artifacts. Does **not** touch npm. |
| `.github/workflows/sdk-publish.yml` | `release` `published` for tags in the `sdk-v*` namespace | GitHub-hosted (`ubuntu-latest`) for the npm job                   | Verifies release/tag/commit alignment; runs `npm publish --provenance` through npm trusted publishing (OIDC). Does **not** run on Blacksmith.  |

### `sdk-release` behavior (draft prep)

- Reads version from `packages/sdk/package.json`; no manual version input.
- Derives tag `sdk-v{version}` from that version.
- Runs the same local gates agents use (`verify:push`-class checks) plus SDK-specific packaging
  checks: repo-lint publish policy, `pnpm --filter @splitch/sdk build`, test, `pack --dry-run`,
  consumer-smoke evidence.
- Creates or updates a **draft** GitHub Release for the derived tag on the dispatch commit.
- Refuses to mutate a GitHub Release that is already **published** for the same SDK version.
- Attaches review artifacts: packed contents listing, checksums, dependency inventory or SBOM, and
  validation logs sufficient for maintainer review before npm.
- Uses no npm token, trusted-publisher credential, or package-registry secret.

### `sdk-publish` behavior (trusted npm)

- Triggers only when a GitHub Release is **published** and the release tag matches `sdk-v*`.
- Runs the npm publish job on **GitHub-hosted** runners — required for npm trusted publishing; the
  final publish job must not run on Blacksmith.
- Uses npm trusted publishing (OIDC). No long-lived npm token is part of this path.
- Verifies release tag matches `packages/sdk/package.json` version, and that the release target commit
  is the commit being built and attested.
- Refuses to publish when the GitHub repository is still **private** (provenance-backed npm publish
  requires a public repository).
- Publishes `@splitch/sdk` with `npm publish --provenance` and dist-tag `latest` for `0.1.0`.
- Skips safely when the exact version already exists on npm; never overwrites a published version.
- Logs package name, version, tag, commit SHA, runner class, provenance mode, dist-tag, and
  skip/publish decision.

## Tag protection and immutable releases

- Protect the `sdk-v*` tag namespace with a GitHub tag protection rule or repository ruleset before the
  first public release. Human-owned setup; track completion on the owning Linear ticket.
- **Draft** releases for a given SDK version may be updated by `sdk-release` while still draft.
- **Published** GitHub Releases and published npm versions are immutable. Workflows must not rewrite
  an already-published release or republish an existing npm version.

## Package invariants

- `@splitch/contracts` stays **private** and is never published as a separate npm package.
- Public SDK types exposed to consumers are **derived** from the live private contracts at build time.
  Do not hand-copy or manually maintain duplicate contract types in `@splitch/sdk`.
- Published `.d.ts` files must not require consumers to install or resolve `@splitch/contracts`.
- Packed manifests must not leak private workspace dependencies or private contract imports. Repo-lint
  publish-policy gates enforce this locally and in CI.

## Human-owned provider setup (before first public release)

These steps are human-owned provider mutations. This runbook names them; agents must not perform them
or store secrets in the repo. Track completion on Linear.

| Provider | Action                                                                                                                                          | Why                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| GitHub   | Make `github.com/zaks-io/splitch` **public** before the first provenance-backed npm release.                                                    | `sdk-publish` fails closed on a private repository.                  |
| npm      | Create `@splitch` org scope (or confirm ownership) and register the package name `@splitch/sdk`.                                                | First publish target.                                                |
| npm      | Configure **trusted publisher** for `@splitch/sdk` pointing at `zaks-io/splitch`, workflow file `sdk-publish.yml`, environment `github` (OIDC). | Replaces long-lived npm tokens; required for provenance.             |
| GitHub   | Add tag protection or a ruleset for `sdk-v*` tags.                                                                                              | Prevents accidental or unauthorized tag moves in the SDK namespace.  |
| GitHub   | Enable **immutable releases** (or equivalent release immutability policy) for published SDK releases.                                           | Published release artifacts must not be rewritten after npm publish. |

## Maintainer procedure

1. Land a release PR on `main` that bumps `packages/sdk/package.json` to the target version and
   includes README, license, and package metadata required for public npm.
2. Run local proof: `pnpm verify:push`, `pnpm --filter @splitch/sdk test`, `pnpm --filter @splitch/sdk build`,
   `pnpm --filter @splitch/sdk pack --dry-run`.
3. Complete the human-owned provider setup table above.
4. Dispatch **`sdk-release`** from the validated `main` commit. Review draft-release artifacts in the
   workflow summary.
5. Inspect the draft GitHub Release: tag `sdk-v{version}`, correct target commit, release notes, and
   attached evidence.
6. When satisfied, **publish** the GitHub Release (not merely create a tag). That event alone triggers
   **`sdk-publish`** and npm.
7. After npm succeeds, verify npm shows provenance for `@splitch/sdk@{version}` and dist-tag `latest`.

## First-release checklist: `@splitch/sdk@0.1.0`

- [ ] `packages/sdk/package.json` `version` is `0.1.0`.
- [ ] Package metadata is complete: `name`, `description`, `license`, `repository`, `exports`, `files`,
      `engines`, and public README are ready for npm.
- [ ] `@splitch/contracts` is not a runtime or publish dependency in the packed manifest.
- [ ] Public types are build-generated from contracts, not hand-copied.
- [ ] GitHub repository is public.
- [ ] npm trusted publisher is configured for `sdk-publish.yml` on GitHub-hosted runners.
- [ ] `sdk-v*` tag protection or ruleset is active.
- [ ] GitHub immutable-release policy is enabled for published SDK releases.
- [ ] `sdk-release` draft run produced pack dry-run output, checksums, dependency inventory or SBOM,
      consumer-smoke evidence, and validation logs.
- [ ] Draft GitHub Release reviewed; publishing it is the explicit maintainer decision to ship.
- [ ] After publish: npm lists `@splitch/sdk@0.1.0` with dist-tag `latest` and provenance attestation.

## What does not trigger npm

- Pushing an `sdk-v*` tag without publishing a GitHub Release.
- Running `sdk-release` (draft prep only).
- Any workflow dispatch other than publishing the GitHub Release.
- Blacksmith jobs (build/validation only; never the trusted publish job).

## Sources

- [SPL-125: public npm release path spec](https://linear.app/zaks-io/issue/SPL-125)
- [SPL-129: draft release workflow](https://linear.app/zaks-io/issue/SPL-129)
- [SPL-130: trusted publish workflow](https://linear.app/zaks-io/issue/SPL-130)
- [deployment-pipeline.md](./deployment-pipeline.md)
- [monorepo-and-toolchain.md](./monorepo-and-toolchain.md)
- [local-quality-gates.md](./local-quality-gates.md)
- [ADR-0035](../../adr/0035-security-automation-and-supply-chain-integrity-are-an-enforced-ci-contract.md)
- npm trusted publishing: <https://docs.npmjs.com/trusted-publishers>
- npm provenance: <https://docs.npmjs.com/generating-provenance-statements>
