# SDK release runbook

This runbook is the operating contract for publishing `@splitch/sdk`. It documents the
implemented workflow path and the human-owned provider setup it depends on. It does not grant
permission to publish, change repository visibility, configure providers, or change tag/release
rules.

## Release model

`packages/sdk/package.json` is the source of truth for the SDK version. At this time the release
helpers accept only `0.1.0`; they derive the release tag as `sdk-v0.1.0`. Do not enter or create a
release tag by hand.

The package is public (`publishConfig.access = public`). `@splitch/contracts` remains private:
the SDK build derives its public declaration surface from the source-of-truth contracts, and the
published manifest and declarations must not require `@splitch/contracts`.

There are two deliberately separate workflows:

| Workflow                                                    | Trigger and runner                                              | Result                                                                                                                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`sdk-release`](../../../.github/workflows/sdk-release.yml) | Manual `workflow_dispatch`; Blacksmith                          | Validates the candidate, creates release artifacts, and creates or updates a **draft** GitHub Release for `sdk-v<version>`. It never publishes to npm.                                   |
| [`sdk-publish`](../../../.github/workflows/sdk-publish.yml) | A GitHub Release is **published**; GitHub-hosted `ubuntu-24.04` | Revalidates the live release source, then uses npm trusted publishing/OIDC to run `npm publish --provenance --access public --tag latest`, or safely skips an already-published version. |

Pushing an `sdk-v*` tag by itself does not publish to npm. Only the `release: published` event
can enter `sdk-publish`. Blacksmith handles validation, packaging, and draft preparation; npm
trusted publishing's final job intentionally runs on GitHub-hosted infrastructure, not
Blacksmith.

## Provider setup before the first stable release

These are human-owned provider actions. Record completion in the release PR or release evidence,
but do not put credentials, tokens, signed URLs, or private logs in this repository.

| Owner                                           | Required setup                                                                                                                                                                                                                                                                                                                                                       | Evidence to retain                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| GitHub repository administrator                 | Make `zaks-io/splitch` public before the stable release. `sdk-publish` fails closed when live repository visibility is not public.                                                                                                                                                                                                                                   | Repository visibility is public immediately before release publication.                                  |
| GitHub repository or organization administrator | Enable immutable releases. Draft releases remain editable while they are drafts; after publication, release assets and the associated tag must be immutable.                                                                                                                                                                                                         | GitHub shows the published release as immutable; record the release URL and `sdk-v0.1.0` commit.         |
| GitHub repository or organization administrator | Create an active tag ruleset targeting `sdk-v*` that restricts tag creation, update, and deletion. Give the minimum bypass needed for the authenticated `sdk-release` workflow to create or update a **draft** tag. The workflow force-updates its draft tag, so test this permission before the stable release. Do not grant a broad human or unrelated-app bypass. | Ruleset name, target pattern, restrictions, and narrowly scoped bypass are reviewed by an administrator. |
| npm organization administrator                  | Ensure the `@splitch` scope and `@splitch/sdk` package are controlled by the intended organization. Complete the one-time bootstrap below before configuring trusted publishing.                                                                                                                                                                                     | Package ownership and organization write access are confirmed by the responsible human.                  |
| npm organization administrator                  | Configure the sole GitHub Actions trusted publisher for repository owner `zaks-io`, repository `splitch`, workflow filename `sdk-publish.yml`, and allowed action `npm publish`. Do not set an environment name unless the workflow is changed to use that exact environment.                                                                                        | npm's trusted-publisher view matches those values exactly, including the `.yml` filename.                |
| Bootstrap publisher                             | Remove temporary publishing access after bootstrap. Normal `sdk-publish` has no long-lived npm token and must remain OIDC-only.                                                                                                                                                                                                                                      | Temporary access is removed and no npm token was added to repository secrets.                            |

Immutable releases are part of the release boundary, not an optional afterthought. The publish
workflow independently verifies that the live release is published, non-prerelease, immutable,
and tied to one matching remote tag, release target, checked-out commit, and `GITHUB_SHA`.

### One-time npm bootstrap

npm trusted publishing requires an existing npm package. Before the first stable release, a human
with npm organization write access and 2FA manually publishes exactly
`@splitch/sdk@0.1.0-bootstrap.0` with dist-tag `bootstrap`. This disposable prerelease must not
consume `0.1.0`, `latest`, or the stable tag, and it does not make the stable release's provenance
claim. Then configure and verify the trusted publisher, remove the temporary publishing access,
and continue through the normal draft-release flow.

## First stable release: `@splitch/sdk@0.1.0`

Use this procedure only after a human approves the release. It is a checklist, not an automated
deployment command.

### 1. Candidate and metadata

- [ ] `packages/sdk/package.json` says `name: "@splitch/sdk"` and `version: "0.1.0"`.
- [ ] Its metadata is ready for npm consumers: description, Apache-2.0 SPDX license, repository
      URL and `packages/sdk` directory, ESM exports, supported Node engine, public access, and a
      `dist`-only files whitelist.
- [ ] Review consumer-facing README and license material. The package tarball is the authority for
      what ships, so treat an absent README or license in its dry-run listing as a release blocker
      until the package contents are intentionally corrected.
- [ ] Confirm the built declarations and packed manifest contain no `@splitch/contracts` dependency
      or import. Public types must remain build-derived, never hand-copied.
- [ ] Run the candidate evidence required by `sdk-release`: format, lint, typecheck, SDK tests,
      SDK build, pack dry-run, pack check, consumer smoke, and `verify:push`.

### 2. Provider readiness

- [ ] The repository is public.
- [ ] Immutable releases are enabled and the `sdk-v*` tag ruleset is active with its narrow draft
      workflow bypass tested.
- [ ] The bootstrap prerelease exists only as `0.1.0-bootstrap.0` under dist-tag `bootstrap`.
- [ ] npm trusted publisher matches `zaks-io/splitch`, `sdk-publish.yml`, and `npm publish`.
- [ ] Temporary bootstrap access is removed; no long-lived npm token is available to the normal
      publish workflow.

### 3. Prepare the draft

1. Manually dispatch `sdk-release` from the approved commit. It resolves the version from the
   checked-in SDK manifest and validates it before touching a release.
2. Inspect the `sdk-release-validation-sdk-v0.1.0` and `sdk-release-package-sdk-v0.1.0` workflow
   artifacts. They include validation logs/summaries, the packed tarball, checksum,
   tarball-contents listing, dependency inventory, and release manifest.
3. Inspect the draft GitHub Release for `sdk-v0.1.0`: its target must be the validated commit, and
   the attached artifacts must be the reviewed ones. A rerun may update this draft only; it refuses
   to mutate an already-published release.

### 4. Release publication and verification

1. Change the reviewed GitHub Release from draft to published. Do not create a second tag or release
   manually.
2. Confirm the resulting `sdk-publish` run used `ubuntu-24.04`, checked out `sdk-v0.1.0`, and
   reported the same release tag, release target commit, checked-out commit, and `GITHUB_SHA`.
3. Confirm its summary reports provenance/OIDC, dist-tag `latest`, and either `publish` or
   `skip-already-published`. A skip is correct only when exactly `@splitch/sdk@0.1.0` already
   exists; npm versions are immutable and must never be overwritten.
4. Confirm the published GitHub Release is immutable and retain the release URL, npm package URL,
   commit SHA, workflow URLs, and artifact/checksum evidence with the release record.

If any provider check fails, stop. Fix the human-owned setup or release metadata, then repeat only
the draft-safe preparation steps. Do not add an npm token, make an ad hoc publish, or move a
published release/tag to work around the failure.

## Operational boundaries

- The normal path publishes only `@splitch/sdk` and only with dist-tag `latest`.
- The publish workflow rejects a private repository, a wrong SDK tag or version, mismatched commit
  evidence, a non-immutable or unpublished release, and a changed remote tag.
- Release preparation has GitHub `contents: write` only because it creates/updates a draft tag and
  draft release. The trusted-publish workflow has read-only contents plus OIDC `id-token: write`.
- This runbook does not replace the general deployment contract in
  [deployment-pipeline.md](./deployment-pipeline.md) or the local verification rules in
  [local-quality-gates.md](./local-quality-gates.md).

## Sources

- [`packages/sdk/package.json`](../../../packages/sdk/package.json)
- [`sdk-release` workflow](../../../.github/workflows/sdk-release.yml)
- [`sdk-publish` workflow](../../../.github/workflows/sdk-publish.yml)
- [Deployment pipeline](./deployment-pipeline.md)
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [GitHub tag rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
