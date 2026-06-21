# Security model

Security is an **enforced product contract** in splitch, on the same footing as
statistical rigor (ADR-0030) and privacy (ADR-0032). This file is the one place
that states the trust boundaries and threat model; the enforcing contracts live
in the documents linked under each boundary and in `SECURITY.md` at the repo
root (disclosure policy and CI controls).

## Principle

Secure by default, least privilege, fail loud. A control that can be silently
bypassed is not a control. Every credential, every cross-tenant read, and every
edge entry point is scoped, validated, and auditable.

## Trust boundaries

The system has four boundaries where untrusted input meets trusted state. Each
has a canonical enforcing contract.

### 1. The public edge (data plane)

The Evaluation Worker is reachable by untrusted clients holding a **Client Key**.

- Client Keys are public and origin-closed; `peek()` is **API-Key-only**; anon
  registration is gated by Turnstile; revoke is **fail-loud**.
- Canonical contract: **ADR-0034** + [`edge-abuse-controls`](../pipeline/edge-ingest-contract.md).

### 2. Tenant isolation

D1 has **no row-level security**. The data-access seam is the only thing that
keeps one App's data from another's.

- Every read and write is scoped by `app_id` in the data-access seam; that
  scoping **is** the security boundary, not a convenience.
- Canonical contract: **ADR-0018** + [`multi-tenant-isolation`](./multi-tenant-isolation.md).
- Enforced in code by the `splitch-tenant-scoping-required` Semgrep rule.

### 3. Credentials

Two key classes with different blast radii.

- **API Key** (secret, server-side): provisioned, never read back after
  creation, never returned in a response, never logged.
- **Client Key** (public, client-side): safe to embed, origin-closed, no write
  authority.
- Canonical contract: [`credentials-and-keys`](../control-plane/credentials-and-keys.md), [`auth-doors`](../control-plane/auth-doors.md), [`access-control-matrix`](../control-plane/access-control-matrix.md).
- Enforced in code by the `splitch-api-key-never-returned` and
  `splitch-no-secret-in-logs` Semgrep rules and by gitleaks.

### 4. Principals and authorization

Three doors (human via WorkOS, agent via auth.md, CLI/MCP), one principal model.

- Authorization is matrix-driven, not ad hoc; agents share the Client Key and
  provision — never read — the API Key.
- Canonical contract: **ADR-0022** + [`access-control-matrix`](../control-plane/access-control-matrix.md).

## Privacy

PII handling, deletion, and export are an enforced contract in their own right.

- Canonical contract: **ADR-0032** + [`privacy-data-lifecycle`](./privacy-data-lifecycle.md).

## Supply chain

The build is a trust boundary too. The 2025 tj-actions/reviewdog and 2026
trivy-action compromises were tag-repointing attacks defeated by SHA pinning.

- pnpm install quarantine: `minimumReleaseAge`, `minimumReleaseAgeStrict`,
  `blockExoticSubdeps` (see [`monorepo-and-toolchain`](./monorepo-and-toolchain.md)).
- Every GitHub Action pinned to a full commit SHA with a version comment;
  Harden-Runner egress monitoring on every job; SHA pinning enforced in CI.
- Continuous scanning: CodeQL, Semgrep (incl. repo-local rules), OSV-Scanner,
  Trivy, gitleaks, OpenSSF Scorecard. A daily scheduled workflow re-runs these
  against `main` and opens a tracked issue on any new finding.
- Disclosure and the full CI control list: [`SECURITY.md`](../../../SECURITY.md).

## Threat model (summary)

| Threat                            | Boundary | Primary control                                |
| --------------------------------- | -------- | ---------------------------------------------- |
| Cross-tenant data access          | 2        | `app_id` scoping in data-access seam           |
| Leaked / over-scoped credentials  | 3        | API Key never read back; Client Key closed     |
| Edge abuse (scraping, flooding)   | 1        | Origin-closed Client Keys; Turnstile; quotas   |
| Privilege escalation across doors | 4        | Access-control matrix                          |
| Secret in source / logs           | 3        | gitleaks + Semgrep `no-secret-in-logs`         |
| Malicious dependency / action     | supply   | SHA pins, quarantine, OSV/Trivy, Harden-Runner |
| PII over-retention / leak         | privacy  | Privacy data-lifecycle contract                |

## Sources

- ADR-0035 — security automation and supply-chain integrity are an enforced CI contract (this model's decision record).
- ADR-0018 — identity and operational state in D1; tenant isolation is app-enforced.
- ADR-0022 — agent and human auth via auth.md; one principal, three doors.
- ADR-0032 — privacy data lifecycle is an enforced product contract.
- ADR-0034 — edge abuse controls are a Cloudflare-enforced product contract.
- `SECURITY.md` — vulnerability disclosure policy and CI security controls.
