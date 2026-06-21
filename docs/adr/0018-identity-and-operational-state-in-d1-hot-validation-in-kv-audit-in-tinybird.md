# Identity and operational state in D1; hot validation in KV; audit log in Tinybird

**Status:** accepted

ADR-0017 pinned config, the hot-path assignment substrate, and analytics, but left the boring
relational layer — users, Apps, membership, API keys, billing — without a home. That state lands on
**Cloudflare D1**, keeping splitch all-Cloudflare (ADR-0017) and reusing agent-paste's Drizzle
schema/migration discipline, just pointed at D1 instead of Postgres. The split, by data shape:

- **D1 — the bounded mutable relational system of record.** Users, App, App membership + roles, SDK
  credentials as records (hash, scopes, revoked — both the secret **API Key** and the public **Client
  Key**; see the amendment below), billing (plan/subscription/Stripe linkage). Relational,
  transactional, low-write, single-primary with edge-replicated reads — the exact OLTP shape D1
  serves, and small (megabytes; the unbounded table is routed out, below). Drizzle is the access
  layer.
- **KV — the hot validation caches, never the system of record.** The only genuinely
  per-request-hot reads are **session validation** and **API-key validation on every SDK call**.
  Both are served from edge KV (key hash → cached scopes/validity), write-through from D1 on
  change/revoke — the agent-paste Denylist-KV pattern. The relational store is therefore **not on
  the per-request path**; it is written-to and occasionally queried, not hit per call.
- **Tinybird — the audit log.** Who/what/when is append-only and grows without bound — a telemetry
  shape, not a row-store one. It goes to Tinybird (ADR-0017's analytics substrate), which keeps it
  out of D1 and keeps D1 comfortably under its size ceiling.

**Tenant isolation is application-enforced, not DB-enforced.** Every query is scoped by `app_id` in
a single repository / data-access layer that no query bypasses. This is a deliberate, recorded
downgrade from agent-paste's Postgres row-level-security: D1 has no RLS, so isolation moves from the
database into disciplined application code. Accepted at this stage because the multi-tenant set is
small and the contracts-first + single-data-access-seam discipline contains it; revisit if isolation
requirements harden (see below).

## Considered options

- **Postgres / Neon + Drizzle + RLS (agent-paste's layer)** — rejected for now. Its one decisive
  advantage is **DB-enforced** row-level security for multi-tenant isolation. The cost: a third
  platform and a non-edge region hop, reintroduced for data that is low-volume and not hot in the DB
  sense (the hot reads are served from KV regardless). At this stage application-enforced tenancy in
  a disciplined repository layer is acceptable, so the all-Cloudflare simplicity wins. The single
  thing that flips this back is DB-enforced RLS becoming a hard requirement (compliance, or
  application-level scoping judged insufficient) — the data-access layer is built as the one seam
  through which a later Postgres+RLS move would be mechanical.
- **Everything in D1, audit log included** — rejected: an unbounded append-only audit log pushes D1
  toward its per-database size ceiling and is the wrong shape for a row store. Tinybird already
  exists for exactly this append-only telemetry.
- **Identity/keys hot-read from D1 per request** — rejected: puts the relational store on the
  per-call hot path. Edge KV caches (session + key validity), write-through from D1, keep the hot
  path edge-local and off the system of record.

## Consequences

- **No new platform.** Identity/operational state shares Cloudflare with config and the hot path;
  the stack stays the two stores of ADR-0017 (Cloudflare + Tinybird).
- **The data-access layer is load-bearing for security.** With no RLS, tenant isolation lives in
  one repository seam that every query routes through — reviewable, and the designated migration
  boundary if Postgres+RLS is ever needed.
- **Tinybird is a second isolation seam the repository does not cover.** Tinybird endpoints are
  queried over their own token/parameter path, not through the Drizzle repository, so the "one seam"
  guarantee above does not reach the audit log or any per-tenant analytics read. Isolation there is
  enforced in the pipe itself: every tenant-scoped endpoint takes `app_id` as a **mandatory,
  non-defaulted** parameter (`{{String(app_id)}}` with no default — a missing tenant must fail, not
  fall back to a default tenant or all tenants), and `app_id` is the **first column in
  `ENGINE_SORTING_KEY`** of every tenant-scoped datasource (low-cardinality-first, and never
  timestamp-first in this multi-tenant store). Two seams enforce tenancy, not one — the D1 repository
  and the Tinybird pipe layer — and both are in scope for any isolation review.
- **D1's size ceiling is a non-issue** by construction: the only unbounded table (audit) is in
  Tinybird; the D1 set is bounded mutable records.
- **Usage counters that tick frequently** are not D1 rows — high-frequency metering belongs in a
  Durable Object counter or Analytics Engine, written to D1 only as periodic rollups. (Detail for
  the billing build, not re-litigable here.)
- Drizzle schema/migration tooling carries over from agent-paste; only the driver target changes
  (D1, not Postgres).

## Amendment: SDK credentials are two kinds — a secret API Key and a public Client Key

The original "API keys as records" wording named only one credential; an SDK actually needs **two**, the
standard public/secret split every provider ships (LaunchDarkly client-side ID vs SDK key, Statsig client vs
server key, the `pk_`/`sk_` shape). Both are D1 records validated per-call in KV; they differ by secrecy,
capability, and which runtime uses them. The glossary pins the language (CONTEXT.md, *Credential terms*:
**API Key**, **Client Key**).

- **API Key (secret / server).** For **server-side SDKs** in a trusted runtime. The full-data-plane key the
  original wording described (hash, scopes, revoked; KV hot-validation). Secret **because the runtime holding
  it is private**. **Never** shipped client-side.
- **Client Key (public / publishable).** For **client-side SDKs** (browser, mobile, any untrusted runtime).
  **Non-secret by design** — shipped in client code. Capability is **evaluate-only, App-scoped**: resolve a
  flag value for the Targeting Key in the request, nothing more. It **cannot** return the full config / rule
  set / salt, cannot write, cannot mint keys, cannot reach another App. Blast radius if leaked is "someone
  evaluates your flags as themselves" — bounded by design. Abuse is contained at the **edge** (origin/referrer
  allow-list bound to the key, per-key rate limiting via the Cloudflare WAF already in use for ADR-0022's
  anon-registration surface), **not** by hiding the value.

Two consequences this ADR now pins:

- **The evaluate endpoint must be safe under a public credential.** It returns only the resolved Variant for
  the requested Targeting Key — never bulk config, the rule set, the salt, or other Entities' assignments.
  This is a hard endpoint-design constraint, not a policy bolted on later. (The control-plane config-read
  surface, which *does* return rule sets, is a different surface reached with the control-plane token of
  ADR-0022, never with a Client Key.)
- **The agent/control plane (CLI / MCP) freely retrieves and surfaces a Client Key** (it is public). For the
  secret **API Key** it **provisions and revokes** but **does not read an existing key's value** — it surfaces
  the secret once at creation, the way every provider does, then directs the developer to where it lives
  (consistent with ADR-0022's secret discipline). KV validation is identical for both kinds; what differs is
  secrecy, capability, edge binding, and agent-reachability.
