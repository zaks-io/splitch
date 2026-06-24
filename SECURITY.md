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

If you cannot use GitHub, email **security@isaacsuttell.com** with details and we
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
`@splitch/sdk`, the CLI, the MCP server, and shared packages, plus the CI/CD
and supply-chain configuration in `.github/` and the repo root.

Out of scope: vulnerabilities in third-party platforms we build on (Cloudflare,
Tinybird, WorkOS) — report those to the respective vendor; findings that require
a compromised maintainer account or physical access; volumetric DoS.

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

> **Pre-build status:** splitch is in active early development. The automated scanning gates listed
> below are configured and ready, but **enforcement is deferred** until the application and its
> dependency set are built out — running them now would gate work on dependency noise rather than real
> findings. Secret scanning (gitleaks) and in-code boundary checks remain active throughout. Turning
> the full battery back on is a tracked launch prerequisite (ADR-0035).

Continuous controls (target posture; see status note above):

- **Dependency scanning** — Dependabot alerts/updates plus OSV-Scanner in CI;
  pnpm supply-chain quarantine (`minimumReleaseAge`, `blockExoticSubdeps`).
- **SAST** — CodeQL (security-extended) and Semgrep, including repo-local rules
  for splitch-specific invariants (tenant scoping, secret handling).
- **Secret scanning** — gitleaks on every push and PR.
- **Supply-chain integrity** — every GitHub Action pinned to a full commit SHA;
  StepSecurity Harden-Runner egress monitoring; SHA pinning enforced in CI.
- **Filesystem CVE scanning** — Trivy.
- **Posture** — OpenSSF Scorecard, run daily.
- **Daily scan** — a scheduled workflow re-runs the above against `main` and
  opens a tracked issue when anything flips.

## Supported versions

splitch is pre-1.0; only the latest `main` and the most recent published
`@splitch/sdk` receive security fixes until a stable release line exists.

| Version         | Supported |
| --------------- | --------- |
| `main` (latest) | ✅        |
| older commits   | ❌        |
