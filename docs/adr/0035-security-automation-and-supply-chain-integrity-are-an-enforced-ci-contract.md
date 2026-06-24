# Security automation and supply-chain integrity are an enforced CI contract

**Status:** accepted — **enforcement deferred until the app is built (see Rollout phase below)**

> **Rollout phase (build-fast).** This ADR defines the target security posture, and the tooling is
> in the repo, but during the pre-build phase the **dependency/CVE/SAST/supply-chain gates are
> parked**, not enforcing. Pre-build they only fail builds on noise unrelated to the work in flight —
> a transitive dev-dependency CVE, SAST over scaffolding, a freshly published or non-registry
> transitive blocked at install — which makes agents detour to fix dependency churn instead of
> shipping. The deterministic, your-code-only checks stay on (gitleaks secret scanning, linters,
> typecheck, knip). The plan: build everything, audit the **final** dependency set once, fix, then
> turn every gate in this ADR back on and ratchet from there. **Re-enabling is a single, explicit
> lockdown milestone — a launch prerequisite — not something done incrementally per-PR.** What is
> currently parked and how to restore it is tracked in
> [local-quality-gates.md](../spec/platform/local-quality-gates.md).

Splitch is public and asks others to trust it with flag config, SDK credentials, and per-tenant
data. ADRs 0018, 0022, 0032, and 0034 each pinned one security boundary as an enforced product
contract, but the security _posture as a whole_ was implicit: scattered across feature docs, with no
single statement of the threat model and no continuous verification that the controls hold over time.
This ADR makes security a first-class, CI-carried contract with one canonical home, and pins the
supply chain itself as a trust boundary — the 2025 tj-actions/reviewdog and 2026 trivy-action
compromises were tag-repointing attacks against exactly the kind of CI a project like this runs.

## Decision

Security is an enforced contract on the same footing as statistical rigor (ADR-0030) and privacy
(ADR-0032). It is carried by automation that runs continuously, fails loud, and is verifiable by
anyone reading the repo. Five parts, all mandatory.

### 1. One canonical security model

The trust boundaries and threat model live in one document, `docs/spec/platform/security-model.md`,
which links out to the enforcing contracts (0018 tenant isolation, 0022 auth doors, 0032 privacy,
0034 edge abuse) rather than restating them. Disclosure policy and the CI control list live in
`SECURITY.md` at the repo root. "Secure by default, least privilege, fail loud" is a stated design
principle, not an emergent property.

### 2. Layered continuous scanning, surfaced in the Security tab

CodeQL (security-extended), Semgrep (stock rulesets plus repo-local rules for splitch invariants),
OSV-Scanner, Trivy, gitleaks, and OpenSSF Scorecard run in CI. All findings normalize to SARIF in
the GitHub Security tab. No single tool is trusted to catch everything; the layers have different
blind spots by design.

### 3. Gate on change, alert on schedule

_(Parked in the build-fast phase: `security.yml` and `codeql.yml` are `workflow_dispatch`-only, so
nothing below gates a PR yet. The jobs are unchanged and ready; the lockdown milestone flips their
triggers back to `pull_request`/`push`.)_

On pull_request/push, a high-or-critical finding fails the job so branch protection blocks the merge.
A daily scheduled run re-runs the same scans against `main` — there is nothing to gate, so it uploads
SARIF and opens a single deduped tracking issue instead. New CVEs disclosed against already-merged
code surface within a day, not at the next unrelated PR.

### 4. The build is a trust boundary

Every GitHub Action is pinned to a full commit SHA with a version comment; tag references are
forbidden and enforced in CI (`pinact -check`). StepSecurity Harden-Runner monitors egress on every
job. This composes with the pnpm install-time quarantine (`minimumReleaseAge`, `blockExoticSubdeps`).
Dependabot keeps both the SHA and the comment current, so pinning costs no update automation.

_(Parked in the build-fast phase: the `pinact -check` gate and the pnpm install quarantine are off so
they don't fail builds/installs on actions or transitives unrelated to the work in flight. SHA-pinning
the actions we keep is still good practice; the lockdown milestone re-enables the `pinact` gate and
uncomments the pnpm quarantine.)_

### 5. Local gates mirror CI

The same secret, SAST, dependency-audit, and pin checks run via Lefthook before code leaves the
machine. Tools absent locally warn and skip so contributors are not forced to install Python/Go
toolchains; in CI the same checks are required and fail loud. Bad commits fail before they are pushed.

_(Parked in the build-fast phase: the local Lefthook gate runs only the deterministic, your-code-only
checks — format, lint, typecheck, knip, gitleaks. SAST, dependency-audit, and pin checks are out of
the `verify:*` path; the `security:full` script still runs the whole battery on demand, and the
lockdown milestone restores it to `verify:ci`.)_

## Considered options

- **Leave security implicit across feature docs** — rejected. The controls existed but nothing stated
  the posture or threat model, so a reader (or auditor, or prospective user) could not assess it, and
  nothing verified the controls still held. Implicit security is unverifiable security.
- **Alert-only, never gate merges** — rejected. A known high/critical advisory that can still merge is
  not a contract. Gating on change is the cheapest point to stop a regression.
- **Reference actions by tag and rely on Dependabot to bump** — rejected. Tags are mutable; the
  tj-actions, reviewdog, and trivy-action attacks all repointed tags to malware. SHA pins defeat this
  and Dependabot bumps SHAs just as well as tags.
- **Trust a single SAST/dependency tool** — rejected. CodeQL, Semgrep, OSV, and Trivy have different
  coverage; relying on one leaves its blind spot unguarded. The marginal CI cost is low.
- **Require security CLIs locally** — rejected as a hard requirement. It would push Python/Go onto
  every contributor for a check CI already enforces; warn-and-skip locally with required-in-CI keeps
  the gate authoritative without the friction.

## Consequences

- A new top-level `SECURITY.md`, root `README.md` (with CI/CodeQL/Security/Scorecard badges), and
  `docs/spec/platform/security-model.md`; the spec and platform READMEs index the security model.
- Two new workflows (`security.yml`, `codeql.yml`) and hardening of the existing `ci.yml`, which
  carries the range-scoped Gitleaks secret scan as a dedicated step; a Dependabot config for npm and
  github-actions.
- Repo-local Semgrep rules under `.semgrep/` enforce tenant `app_id` scoping, "API Key never returned
  in a response," and "no secret in logs" — the code-level edge of 0018, 0034, and the credential model.
- CI installs Semgrep and pinact and runs them as required gates; the daily scan depends on the
  GitHub↔Linear sync to mirror its tracking issue into the Splitch team.
- Enabling GitHub Private Vulnerability Reporting and branch protection requiring these checks are
  launch prerequisites for the public repo, consistent with treating security as an enforced contract.
- Pursuing the OpenSSF Scorecard badge (and later the OpenSSF Best Practices badge) becomes a concrete,
  measurable trust signal rather than an aspiration.

## Sources

- [ADR-0017: all-Cloudflare stack](./0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md)
- [ADR-0018: identity and operational state in D1; hot validation in KV; audit in Tinybird](./0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0022: agent and human auth, one principal three doors](./0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
- [ADR-0030: statistical rigor is an enforced product contract](./0030-statistical-rigor-is-an-enforced-product-contract.md)
- [ADR-0032: privacy/data lifecycle is an enforced product contract](./0032-privacy-data-lifecycle-is-an-enforced-product-contract.md)
- [ADR-0034: edge abuse controls are a Cloudflare-enforced product contract](./0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md)
- [Security model spec](../spec/platform/security-model.md)
- [OpenSSF: securing CI/CD after tj-actions and reviewdog](https://openssf.org/blog/2025/06/11/maintainers-guide-securing-ci-cd-pipelines-after-the-tj-actions-and-reviewdog-supply-chain-attacks/)
- [Trivy supply-chain advisory GHSA-69fq-xp46-6x23](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23)
