# Package release runbook

This runbook is the operating contract for publishing `@splitch/sdk`, `@splitch/cli`, `@splitch/convex`, and
`@splitch/cloudflare`. It
documents the implemented workflow path and the human-owned provider setup it depends on. It does
not grant permission to publish, change repository visibility, configure providers, or change
tag/release rules.

## Release model

Each package manifest is the source of truth for its version: the release workflows release
exactly the version checked into the target's `package.json`, and the version bump PR is the
reviewed act of cutting a release. Dispatching a release workflow for a version whose tag already
has a published release is a deliberate no-op, not a failure: the validate job green-skips with a
step summary and annotation telling you to bump the manifest, and nothing is validated or
drafted. Every unexpected state (a tag that moved, a published release being mutated, mismatched
commit evidence) still fails loudly.

`cli-v0.1.0` is a burned release: it was published targeting a commit whose manifest npm's
publish-time fixer would strip the `bin` from, its publish run failed before npm was reachable,
and the published release/tag are immutable. Never re-run its failed `cli-publish` run; it would
consume npm version `0.1.0` with a binary-less package. The CLI's first stable version is
`0.1.1`.

`cloudflare-v0.1.0` is a burned tag: it was published before the package's npm trusted publisher
existed, so `cloudflare-publish` failed with `E404`. Deleting the release freed the tag for
deletion but [immutable releases permanently block reusing a released tag
name](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases),
so `cloudflare-release` can no longer move it and fails with `GH013`. npm never received `0.1.0`;
only the tag name is spent. The Cloudflare package's first stable version is `0.1.1`. Any target
whose tag name is burned this way is recovered the same way: bump the manifest, never force the
tag.

| Target       | Manifest                           | Tag                     | Draft workflow                                              | Trusted-publish workflow                                    |
| ------------ | ---------------------------------- | ----------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| `sdk`        | `packages/sdk/package.json`        | `sdk-v<version>`        | [`sdk-release`](../../../.github/workflows/sdk-release.yml) | [`sdk-publish`](../../../.github/workflows/sdk-publish.yml) |
| `cli`        | `apps/cli/package.json`            | `cli-v<version>`        | [`cli-release`](../../../.github/workflows/cli-release.yml) | [`cli-publish`](../../../.github/workflows/cli-publish.yml) |
| `convex`     | `packages/convex/package.json`     | `convex-v<version>`     | `convex-release`                                            | `convex-publish`                                            |
| `cloudflare` | `packages/cloudflare/package.json` | `cloudflare-v<version>` | `cloudflare-release`                                        | `cloudflare-publish`                                        |

The release workflows are manual `workflow_dispatch` jobs on Blacksmith. They validate the
repo-wide candidate, prepare artifacts, and create or update a draft GitHub Release. They never
publish to npm. Publishing the reviewed GitHub Release triggers the matching package's
GitHub-hosted `ubuntu-24.04` workflow, which revalidates live release state and runs
`npm publish --provenance --access public --tag latest` through npm trusted publishing/OIDC. After
that job succeeds, the package publish workflow is complete. Package releases do not create Linear
Releases. The platform deploy continues to use `LINEAR_ACCESS_KEY` for platform release tracking.

Pushing a namespaced tag alone does not publish. The publish workflows accept only a
`release: published` event and filter their own `sdk-v*`, `cli-v*`, `convex-v*`, or `cloudflare-v*` namespace.

The SDK derives its public declaration surface from private contracts and implementation packages.
Its manifest and declarations must not require a private `@splitch/*` package. The CLI and Convex
packages keep `@splitch/sdk` external and publish a caret dependency resolved from `workspace:^`.
Candidate smoke tests install both local tarballs. Trusted publish fails unless the referenced SDK
version already exists on npm.

Release a shared change in dependency order: SDK first, then CLI and Convex. A CLI or Convex GitHub
Release may be drafted before the SDK publish finishes, but its trusted publish job must not proceed
until the exact checked-in SDK version is available.

## Provider setup before a first stable release

These are human-owned provider actions. Retain evidence with the release record, but never commit
credentials, tokens, signed URLs, or private logs.

1. Make `zaks-io/splitch` public. Both publish workflows fail closed unless the live repository is
   public.
2. Enable immutable releases. A publish workflow requires a published, non-prerelease, immutable
   GitHub Release tied to one matching tag, target commit, checked-out commit, and `GITHUB_SHA`.
3. Maintain separate tag rulesets for `sdk-v*`, `cli-v*`, `convex-v*`, and `cloudflare-v*`. Each ruleset restricts
   tag creation, update, and deletion. The dedicated release GitHub App is the sole bypass actor for
   all three. It
   uses repository variable `SDK_RELEASE_APP_ID` and secret `SDK_RELEASE_APP_PRIVATE_KEY`, has only
   repository `contents: write`, and is installed on `zaks-io/splitch` alone.
4. Confirm the `@splitch` npm scope and all four packages are controlled by the intended organization.
5. Configure one trusted publisher per package:

   | Package               | Repository        | Workflow filename        | Allowed action |
   | --------------------- | ----------------- | ------------------------ | -------------- |
   | `@splitch/sdk`        | `zaks-io/splitch` | `sdk-publish.yml`        | `npm publish`  |
   | `@splitch/cli`        | `zaks-io/splitch` | `cli-publish.yml`        | `npm publish`  |
   | `@splitch/convex`     | `zaks-io/splitch` | `convex-publish.yml`     | `npm publish`  |
   | `@splitch/cloudflare` | `zaks-io/splitch` | `cloudflare-publish.yml` | `npm publish`  |

   Do not configure an environment unless the workflow is changed to use that exact environment.
   `cloudflare-publish` runs its publish job in the `production` environment, so its trusted
   publisher must name that environment; the other three publish jobs declare none.

6. After bootstrap, revoke every temporary publishing token and grant. Set each npm package's
   Publishing Access to disallow token-based publishing. The normal workflows remain OIDC-only.

Do not activate any tag ruleset before the shared App credentials and matching release workflow
are proven able to create and update a draft tag.

### One-time npm bootstrap

npm trusted publishing requires an existing package. A human with npm organization write access
and 2FA manually publishes only the disposable prerelease for the package being bootstrapped:

- `@splitch/sdk@0.1.0-bootstrap.0` with dist-tag `bootstrap`
- `@splitch/cli@0.1.0-bootstrap.0` with dist-tag `bootstrap`
- `@splitch/convex@0.1.0-bootstrap.0` with dist-tag `bootstrap`
- `@splitch/cloudflare@0.1.0-bootstrap.0` with dist-tag `bootstrap`

The prerelease must not consume `0.1.0` or a stable release tag. npm may force `latest` onto the
first-ever version until the stable publish repoints it. Record that state instead of working
around it. Then configure and verify the package's trusted publisher, revoke temporary access,
disallow token publishing, and continue through the normal draft flow.

## Stable release checklist

Use this only after a human approves the package release.

### 1. Candidate and metadata

- [ ] The target manifest has the expected package name and the target's `allowedVersion`.
- [ ] Description, Apache-2.0 SPDX license, repository directory, ESM export, Node engine, public
      access, and dist-only files whitelist are correct.
- [ ] The consumer README and license appear in the actual package tarball.
- [ ] SDK only: declarations contain no private workspace imports; packed runtime dependencies are
      exactly Hono/Zod; root/browser entries remain zod-free; every public subpath passes its size
      and clean-consumer checks.
- [ ] CLI only: `dist/cli.js` has the Node shebang; private workspace packages are bundled; SDK
      imports remain external; the packed manifest resolves `workspace:^` to the checked-in SDK
      caret range and ships no dev dependency.
- [ ] Convex only: the packed manifest resolves the same SDK caret range; a clean install of both
      tarballs passes typecheck and all public subpath imports.
- [ ] Cloudflare only: the tarball carries both the root and `./worker` entries with their
      declarations and a build stamp, ships no source map, and leaks no workspace dependency.
- [ ] Candidate validation passes as one shared Turbo graph covering format, lint, typecheck,
      tests, builds, Knip, secret scanning, Tinybird and D1 checks, pack checks, and consumer smoke.

### 2. Provider readiness

- [ ] The repository is public and immutable releases are enabled.
- [ ] The target's tag ruleset restricts create/update/delete and has the shared release App as its
      sole bypass actor.
- [ ] A draft workflow run proves the App can create or update the target's draft tag.
- [ ] The target bootstrap prerelease exists and no unintended version exists.
- [ ] The trusted publisher is pinned to the target's exact publish workflow filename.
- [ ] Temporary bootstrap access is revoked and npm Publishing Access disallows tokens.

### 3. Prepare the draft

1. Dispatch the target's `sdk-release`, `cli-release`, `convex-release`, or `cloudflare-release`
   from the approved commit.
2. Inspect both `<target>-release-validation-<tag>` and `<target>-release-package-<tag>` artifacts.
   They contain validation evidence, the tarball, checksum, tarball listing, dependency inventory,
   and release manifest.
3. Inspect the draft GitHub Release. Its target and artifacts must match the reviewed evidence. A
   rerun may update a draft only; it refuses to mutate a published release.

### 4. Release publication and verification

1. Change the reviewed draft GitHub Release to published. Do not create another tag or release.
2. Confirm the matching publish workflow used `ubuntu-24.04` and reported identical tag, target,
   checked-out commit, and `GITHUB_SHA`.
3. Confirm the summary reports OIDC/provenance, dist-tag `latest`, and either `publish` or
   `skip-already-published`. A skip is valid only when the exact immutable version already exists.
4. Confirm the package-specific Linear release job succeeded and linked the GitHub Release, npm
   package version, and GitHub Actions run.
5. Retain the immutable release URL, npm package URL, Linear release URL, commit, workflow URLs, and
   checksum evidence.

If a provider check fails, stop. Fix the setup or metadata, then repeat only the draft-safe steps.
Never add an npm token, publish ad hoc, or move a published release/tag around the failure.

## Operational boundaries

- Each workflow publishes only its declared package, namespace, and `latest` dist-tag.
- The publish workflows reject a private repository, wrong tag/version, mismatched commit evidence, mutable or
  unpublished release, or changed remote tag.
- Draft preparation has `contents: write` only for its draft tag and release. Trusted publish has
  read-only contents plus OIDC `id-token: write`.
- This runbook does not replace [deployment-pipeline.md](./deployment-pipeline.md) or
  [local-quality-gates.md](./local-quality-gates.md).

## Sources

- [`@splitch/sdk` manifest](../../../packages/sdk/package.json)
- [`@splitch/cli` manifest](../../../apps/cli/package.json)
- [`sdk-release` workflow](../../../.github/workflows/sdk-release.yml)
- [`sdk-publish` workflow](../../../.github/workflows/sdk-publish.yml)
- [`cli-release` workflow](../../../.github/workflows/cli-release.yml)
- [`cli-publish` workflow](../../../.github/workflows/cli-publish.yml)
- [`cloudflare-release` workflow](../../../.github/workflows/cloudflare-release.yml)
- [`cloudflare-publish` workflow](../../../.github/workflows/cloudflare-publish.yml)
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [GitHub tag rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
