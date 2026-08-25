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
packages (`@splitch/sdk`, `@splitch/cli`, `@splitch/convex`), the MCP server,
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

> **Enforcement status.** The platform is built and shipping, but the dependency, CVE, and SAST
> battery is still **parked behind manual dispatch** pending a one-time audit of the final
> dependency set. Re-enabling it is a single explicit lockdown milestone and a launch prerequisite,
> not an incremental per-PR effort ([ADR-0035](docs/adr/0035-security-automation-and-supply-chain-integrity-are-an-enforced-ci-contract.md)).
> What runs today and what does not is listed below in full, so nobody has to infer it from a badge.

### Enforced on every pull request and push to `main`

- **Secret scanning** — gitleaks over the exact commit range (`pnpm secrets:range`), plus a staged
  scan on every local commit via Lefthook.
- **Hardened CI** — StepSecurity Harden-Runner egress auditing on every job, checkout with
  `persist-credentials: false`, and every GitHub Action pinned to a full commit SHA.
- **Contract and correctness gates** — lint, typecheck, tests, build, dead-code (knip), formatting,
  spec lint, CLI/MCP parity, and D1 migration + Tinybird datafile validation.
- **Dependency alerts** — GitHub Dependabot alerts are on, with monthly grouped version-update pull
  requests for npm and GitHub Actions.
- **Private disclosure** — GitHub Private Vulnerability Reporting is enabled on this repository.

### Configured but not yet enforcing

Each of these is written, SHA-pinned, and runnable today via **Run workflow** on the Actions tab, or
locally with `pnpm security:full`. None of them run on a schedule or gate a merge yet.

- **SAST** — CodeQL (security-extended) in `.github/workflows/codeql.yml`; Semgrep, including
  repo-local rules for splitch-specific invariants in `.semgrep/`, in `.github/workflows/security.yml`.
- **Dependency and CVE scanning** — OSV-Scanner and `pnpm audit`, plus a Trivy filesystem scan, in
  `.github/workflows/security.yml`.
- **Posture** — OpenSSF Scorecard, and the alert job that opens a deduped tracking issue when any
  scan flips, both in `.github/workflows/security.yml`. Because Scorecard has not published a run,
  the Scorecard badge is currently blank.
- **Install-time supply-chain quarantine** — `minimumReleaseAge` and `blockExoticSubdeps` are
  present but commented out in `pnpm-workspace.yaml`.
- **SHA-pin verification** — `pnpm pins:check` (pinact) verifies the pins by hand; it is not wired
  into a workflow, so the pinning above is convention plus Dependabot, not a gate.

## Supported versions

splitch is pre-1.0. Only the latest `main` and the most recently published version of each package
receive security fixes until a stable release line exists. Fixes ship as a new release; we do not
backport to older versions.

| Artifact                                                           | Supported                |
| ------------------------------------------------------------------ | ------------------------ |
| `main` (latest commit)                                             | Yes                      |
| The hosted service (`splitch.dev` and its subdomains)              | Yes                      |
| [`@splitch/sdk`](https://www.npmjs.com/package/@splitch/sdk)       | Latest published version |
| [`@splitch/cli`](https://www.npmjs.com/package/@splitch/cli)       | Latest published version |
| [`@splitch/convex`](https://www.npmjs.com/package/@splitch/convex) | Latest published version |
| Older commits and older published versions                         | No                       |
