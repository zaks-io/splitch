# Identity and operational state in D1; hot validation in KV; audit log in Tinybird

**Status:** accepted

ADR-0017 pinned config, the hot-path assignment substrate, and analytics, but left the boring
relational layer — users, Apps, membership, API keys, billing — without a home. That state lands on
**Cloudflare D1**, keeping splitch all-Cloudflare (ADR-0017) and reusing agent-paste's Drizzle
schema/migration discipline, just pointed at D1 instead of Postgres. The split, by data shape:

- **D1 — the bounded mutable relational system of record.** Users, App, App membership + roles, API
  keys as records (hash, scopes, revoked), billing (plan/subscription/Stripe linkage). Relational,
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
- **D1's size ceiling is a non-issue** by construction: the only unbounded table (audit) is in
  Tinybird; the D1 set is bounded mutable records.
- **Usage counters that tick frequently** are not D1 rows — high-frequency metering belongs in a
  Durable Object counter or Analytics Engine, written to D1 only as periodic rollups. (Detail for
  the billing build, not re-litigable here.)
- Drizzle schema/migration tooling carries over from agent-paste; only the driver target changes
  (D1, not Postgres).
