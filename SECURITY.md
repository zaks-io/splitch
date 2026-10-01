# Security Policy

splitch handles feature-flag and experiment configuration on the edge, SDK
credentials, and per-tenant data. We take its security seriously and welcome
coordinated disclosure.

## Reporting a vulnerability

**Please do not open a public issue for security reports.**

Report privately through GitHub's
[Private Vulnerability Reporting](https://github.com/zaks-io/splitch/security/advisories/new)
("Report a vulnerability" on the Security tab). This opens a private advisory
visible only to maintainers.

If you cannot use GitHub, email **security@zaks.io** with details and we
will open a private advisory on your behalf.

Include where practical:

- The affected component (Worker, package, CLI, MCP server) and version or commit.
- A description of the issue and its impact.
- Reproduction steps or a proof of concept.
- Any suggested remediation.

## Our commitment

- **Acknowledgement** within **3 business days**.
- **Triage and initial assessment** within **7 business days**.
- We will keep you updated on remediation progress and coordinate a disclosure
  timeline with you. Default embargo target is **90 days** or until a fix ships,
  whichever comes first.
- With your consent, we credit reporters in the advisory.

## Scope

In scope: code in this repository — the Workers under `apps/`, the published
packages (`@splitch/sdk`, `@splitch/cli`, `@splitch/convex`, `@splitch/cloudflare`), the MCP server,
the control panel, and shared packages, plus the CI/CD and supply-chain
configuration in `.github/` and the repo root. The hosted service at
`splitch.dev`, `api.splitch.dev`, `edge.splitch.dev`, `ingest.splitch.dev`,
`auth.splitch.dev`, `mcp.splitch.dev`, and `app.splitch.dev` is in scope under the safe-harbor terms
below.

Out of scope: vulnerabilities in third-party platforms we build on (Cloudflare,
Tinybird, WorkOS, Convex, Sentry) — report those to the respective vendor;
findings that require a compromised maintainer account or physical access;
volumetric DoS.

## Safe harbor

We will not pursue or support legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, and
  service interruption.
- Only interact with accounts they own or have explicit permission to test.
- Give us a reasonable time to remediate before public disclosure.

## How we keep splitch secure

Security is an enforced product contract here, not an afterthought. See
[`docs/spec/platform/security-model.md`](docs/spec/platform/security-model.md)
for the trust boundaries and threat model.

> **Enforcement status.** The dependency audit, Action pin check, and install-time quarantine gate
> every change. The CVE and SAST scanners (OSV-Scanner, Trivy, Semgrep) run **daily and report**:
> findings upload to code scanning, while an operational job failure opens a deduped tracking issue.
> Making those scanners _gate_ a pull request is still one explicit lockdown milestone and a launch
> prerequisite, pending a one-time audit of the final dependency set
> ([ADR-0035](docs/adr/0035-security-automation-and-supply-chain-integrity-are-an-enforced-ci-contract.md)).
> Until then a transitive advisory unrelated to a branch would block that branch, which trains
> people to bypass the gate. What runs today and what does not is listed below in full, so nobody
> has to infer it from a badge.

### Enforced on every pull request and push to `main`

The required **Verify** check in `.github/workflows/ci.yml` runs the secret scan, dependency
audit, quarantine and pin tests, and contract gates below. The hardening applies across every
workflow.

- **Secret scanning**: gitleaks over the exact commit range (`pnpm secrets:range`), plus a staged
  scan on every local commit and a range scan on every push via Lefthook.
- **Dependency audit**: `pnpm audit --audit-level=high` is the first step of `verify:ci`, so a high
  or critical advisory fails the check and blocks the merge.
- **Install-time supply-chain quarantine**: `pnpm-workspace.yaml` sets `minimumReleaseAge: 4320`
  (package versions must be at least 3 days old), `minimumReleaseAgeStrict`, and
  `blockExoticSubdeps`. A script test in `verify:ci` fails if any of these is loosened or a
  release-age exclusion is added.
- **Pinned GitHub Actions**: every third-party Action is pinned to a full commit SHA with a version
  comment. A script test in `verify:ci` (`scripts/privileged-toolchain-pin.test.mjs`) rejects any
  other ref, and the repository's Actions policy requires SHA pinning at run time.
- **Hardened CI**: StepSecurity Harden-Runner egress auditing on every job that checks out code,
  except the production deploy, whose runner path does not support the per-job agent. Every checkout
  sets `persist-credentials: false`, except the release workflows' draft-release jobs, which need a
  push credential. The daily Semgrep and OSV-Scanner jobs run in digest-pinned containers.
- **Contract and correctness gates**: lint, typecheck, tests, build, dead-code (knip), formatting,
  dependency-cruiser architecture boundaries, spec and docs link lint, CLI/MCP parity, and D1
  migration and Tinybird datafile validation when their inputs change.

### Repository settings

- **Private disclosure**: GitHub Private Vulnerability Reporting is enabled on this repository.
- **Dependency updates**: Dependabot is configured for monthly grouped npm and GitHub Actions
  version-update pull requests with a 7-day cooldown. GitHub Dependabot alerts and Dependabot
  security updates are not currently enabled.

### Scanned daily, reported but not gating

`.github/workflows/security.yml` runs at 08:23 UTC every day and has no pull-request or push
trigger. Results upload to the [Security tab](../../security/code-scanning) as SARIF. If a scanner
job cannot execute on the scheduled run, the workflow opens or updates one deduped GitHub issue that
the GitHub↔Linear sync mirrors into the Splitch team. Findings do not fail the jobs or block a
merge. Only the dependency job already has a step that gates on pull requests and pushes; the
Semgrep, OSV-Scanner, and Trivy jobs need gating steps as well as triggers at the lockdown milestone. A
manual **Run workflow** dispatch fails its jobs on operational errors but opens no issue and skips
Scorecard.

- **SAST**: Semgrep with the OSS default ruleset plus repo-local rules for splitch-specific
  invariants in `.semgrep/`.
- **Dependency and CVE scanning**: OSV-Scanner across the workspace, plus a Trivy filesystem scan
  for HIGH and CRITICAL.
- **Posture**: OpenSSF Scorecard, published so the badge fills in.

### Configured but not yet enforcing

Each of these is written and runnable today, but none runs on a schedule or gates a merge yet.

- **CodeQL**: security-extended in `.github/workflows/codeql.yml`, dispatch-only from the Actions
  tab. It is the slowest scan in the battery and overlaps Semgrep's coverage, so it waits for the
  lockdown pass rather than running nightly alongside it.
- **Local SAST and pinact**: `pnpm sast` (Semgrep) and `pnpm pins:check` (pinact) run by hand, and
  `pnpm security:full` runs them together with `pnpm audit` and a full-history gitleaks scan. They
  are not wired into Lefthook or `verify:ci`; the SHA-pin script test above is the enforcing check.

## Supported versions

splitch is pre-1.0. Only the latest `main` and the most recently published version of each package
receive security fixes until a stable release line exists. Fixes ship as a new release; we do not
backport to older versions.

| Artifact                                                                   | Supported                |
| -------------------------------------------------------------------------- | ------------------------ |
| `main` (latest commit)                                                     | Yes                      |
| The hosted service (`splitch.dev` and its subdomains)                      | Yes                      |
| [`@splitch/sdk`](https://www.npmjs.com/package/@splitch/sdk)               | Latest published version |
| [`@splitch/cli`](https://www.npmjs.com/package/@splitch/cli)               | Latest published version |
| [`@splitch/convex`](https://www.npmjs.com/package/@splitch/convex)         | Latest published version |
| [`@splitch/cloudflare`](https://www.npmjs.com/package/@splitch/cloudflare) | Latest published version |
| Older commits and older published versions                                 | No                       |
