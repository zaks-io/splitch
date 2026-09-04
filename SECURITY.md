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
`splitch.dev`, `api.splitch.dev`, `edge.splitch.dev`, `auth.splitch.dev`,
`mcp.splitch.dev`, and `app.splitch.dev` is in scope under the safe-harbor terms
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

> **Enforcement status.** The dependency, CVE, and SAST battery now runs **daily and reports**:
> findings upload to code scanning, while an operational job failure opens a deduped tracking issue.
> Making those same scans
> _gate_ a pull request is still one explicit lockdown milestone and a launch prerequisite, pending
> a one-time audit of the final dependency set
> ([ADR-0035](docs/adr/0035-security-automation-and-supply-chain-integrity-are-an-enforced-ci-contract.md)).
> Until then a transitive advisory unrelated to a branch would block that branch, which trains
> people to bypass the gate. What runs today and what does not is listed below in full, so nobody
> has to infer it from a badge.

### Enforced on every pull request and push to `main`

- **Secret scanning** — gitleaks over the exact commit range (`pnpm secrets:range`), plus a staged
  scan on every local commit via Lefthook.
- **Hardened CI** — StepSecurity Harden-Runner egress auditing on each host-run security job,
  a digest-pinned container for Semgrep, checkout with `persist-credentials: false`, and every
  GitHub Action pinned to a full commit SHA.
- **Contract and correctness gates** — lint, typecheck, tests, build, dead-code (knip), formatting,
  spec lint, CLI/MCP parity, and D1 migration + Tinybird datafile validation.
- **Dependency updates** — Dependabot is configured for monthly grouped npm and GitHub Actions
  version-update pull requests. GitHub Dependabot alerts are not currently enabled.
- **Private disclosure** — GitHub Private Vulnerability Reporting is enabled on this repository.

### Scanned daily, reported but not gating

`.github/workflows/security.yml` runs at 08:23 UTC every day. Results upload to the
[Security tab](../../security/code-scanning) as SARIF. If a scanner job cannot execute, the workflow
opens or updates one deduped GitHub issue that the GitHub↔Linear sync mirrors into the Splitch team.
Findings do not fail the scheduled jobs or block a merge; the same jobs already carry the gating
branches for when the lockdown milestone lands.

- **SAST** — Semgrep with the OSS default ruleset plus repo-local rules for splitch-specific
  invariants in `.semgrep/`.
- **Dependency and CVE scanning** — OSV-Scanner across the workspace, plus a Trivy filesystem scan
  for HIGH and CRITICAL.
- **Posture** — OpenSSF Scorecard, published so the badge fills in.

### Configured but not yet enforcing

Each of these is written, SHA-pinned, and runnable today via **Run workflow** on the Actions tab, or
locally with `pnpm security:full`. None of them run on a schedule or gate a merge yet.

- **CodeQL** — security-extended in `.github/workflows/codeql.yml`, dispatch-only. It is the
  slowest scan in the battery and overlaps Semgrep's coverage, so it waits for the lockdown pass
  rather than running nightly alongside it.
- **`pnpm audit`** — wired into the daily workflow but gated to `pull_request`/`push`, so it is
  inert until those triggers turn on. OSV-Scanner covers the same lockfile in the meantime.
- **Install-time supply-chain quarantine** — `minimumReleaseAge` and `blockExoticSubdeps` are
  present but commented out in `pnpm-workspace.yaml`.
- **SHA-pin verification** — `pnpm pins:check` (pinact) verifies the pins by hand; it is not wired
  into a workflow, so the pinning above is convention plus Dependabot, not a gate.

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
