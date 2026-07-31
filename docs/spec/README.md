# splitch — specification

This is the **final-state source of truth** for building splitch. Read the spec; you should not
need to read the ADRs to implement. The [vision](../vision.md) is the north star this serves (who
it's for and what "good" means); the [ADRs](../adr/) record _why_ each decision was made and
the [architecture seam docs](../architecture/) hold the longer design narrative — all are
referenced from each spec file's `## Sources`, but the spec is what you build against.

- **Context index / ubiquitous language:** [`../../CONTEXT.md`](../../CONTEXT.md). Read it first,
  then follow the domain-specific context link for the area you are touching. Use these terms exactly;
  never invent synonyms.
- **First-run narrative:** [`quickstart.md`](./quickstart.md) — zero to a resolving Flag, the same
  steps for human/agent/panel. It is the canonical text the `splitch://quickstart` MCP resource and
  the `onboard_new_app` prompt serve.

Each area is a directory with a thin `README.md` index and small, single-concern files
(≤165 lines) so an implementing agent reads only what its ticket touches.

## What splitch is

Unified feature flags + A/B experimentation on Cloudflare's edge, built to be agent-first and to
scale to millions of events. Two planes:

- **Data plane (hot path):** the public SDK calls the Evaluation Worker, which resolves a Variant
  (`assign()` + holdover replay) and fires an Exposure. KV serves reads; per-key Durable Objects
  serialize first-touch writes. The Event Ingest Worker owns strict Metric/Web Event intake,
  aggregate admission, durable acceptance, and append-only Tinybird delivery. The accepted target is
  four isolated durable queue-backed NDJSON streams
  ([ADR-0043](../adr/0043-event-ingest-will-use-durable-queue-backed-tinybird-microbatches.md));
  the current implemented `raw_events` and `raw_evaluations` paths still post one row per request
  and have no Queue or Admission Gate binding.
- **Control plane:** authoring (Org/App/Flag/Experiment/Run/Metric/Segment), auth (WorkOS +
  OAuth PRM + auth.md), and the MCP/CLI surfaces — all thin skins over one Zod-first typed contract. The
  analytics/stats engine reads deduped Tinybird serving layers backed by append-only raw logs.

## How we build (applies to every slice)

The [vision](../vision.md) says _what_ to build; these are the non-negotiable rules for _how_:

1. **Production-ready, not a prototype.** Every slice ships as a real, working piece of the final
   system — built to run the author's own production with confidence — never a stub or throwaway.
2. **Progressive, on the final schema.** We build incrementally but on the _final_ data model.
   Deferring a feature is fine; deferring the schema that lets it drop in additively is the trap.
   Hard future features land as additive markers/events with **zero schema or query rewrite**.
3. **Rewrites are failure.** If a change forces us to rewrite work we already shipped, the earlier
   design was wrong. Don't duplicate effort; design the seam once, correctly.

## The spine (read these first)

1. **Assignment** is a pure function `assign(Run, targetingKey) -> variantName` — never recorded.
2. **Exposure** is the only experiment denominator; it is deduped first-touch per `(Entity, Run)`.
   Metric Events supply values without replacing that denominator, and Web Events remain separate
   browser telemetry.
3. **Run** is the immutable unit of analysis; its assignment config is frozen for its life.
   Assignment edits stage on a **draft** and one **Start** opens the next Run; measurement edits
   recompute in place.

## System map (seams)

```
  Public SDK ──evaluate()/peek()──▶ Evaluation Worker
   (Client Key)                       │ reads Provider config (KV)
                                      │ reads AssignmentStore.getAll (KV)
                                      │ assign() on miss / replay on holdover
                                      ├── durable Exposure seal ──▶ Event Ingest Worker ──▶ Queue/Tinybird
                                      └── after seal: AssignmentStore.put
                                                       │
                                                       ▼
                                          per-key DO ──write-through──▶ KV

  Event Ingest data ──▶ first-touch dedup / activation gate ──▶ Analysis Worker
                                                               Stats: variance → CUPED → aCS → FDR

  Humans / Agents ──▶ Control Plane API Worker ◀── CLI + remote MCP Worker
  (WorkOS / OAuth PRM) │ Zod-first contract (@splitch/contracts → hc client)
                        │ writes config via per-App DO → KV + D1, broadcasts nudge
                        ▼
                 D1 (identity, config) · KV (hot validation, edge config) · Tinybird (events, audit)

  Panel + Marketing (TanStack Start, 2 Workers, shared ui) ── hibernating WebSocket nudges ── per-App DO
```

## Areas

| Area                               | Read it for                                                                                                                                           | Canonical home of                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| [domain-model/](./domain-model/)   | the entity model, the Assignment/Exposure/Run spine, the edit taxonomy, holdover semantics                                                            | the **conceptual** model + entity field tables     |
| [contracts/](./contracts/)         | Zod-first contract spine, leaf schemas, request/response envelopes, storage schemas, error model, validation policy                                   | the **canonical shapes** every other area links to |
| [platform/](./platform/)           | storage map, config store, privacy lifecycle, multi-tenant isolation, the security model, the DO substrates, live-update DO, monorepo/toolchain, cron | **where data lives** + the physical substrates     |
| [evaluation/](./evaluation/)       | `assign()`, Provider port, Assignment Store port, evaluate-path orchestration, holdover/replay, exposure firing, dry-run                              | the **hot path** behavior + its ports              |
| [pipeline/](./pipeline/)           | edge ingest, exposure/activation event schema, first-touch dedup query, activation gate query, holdover write, physical Tinybird layer                | the **Exposure pipeline** + event row schemas      |
| [stats/](./stats/)                 | the one CI object, variance + delta method, sequential aCS, CUPED/winsorization, SRM, FDR, dimension slicing, result shapes                           | the **statistics engine**                          |
| [control-plane/](./control-plane/) | Organization tier, auth (doors + access matrix), Run state machine, the full endpoint inventory, MCP/CLI, credentials                                 | the **control-plane API** + auth                   |
| [sdk/](./sdk/)                     | the public data-plane SDK surface, evaluate/peek accessors, Client-Key-safe endpoint, seen-set, five runtimes                                         | the **public SDK contract**                        |
| [frontend/](./frontend/)           | appId-is-the-spine, session/loader isolation, query-key factory, WebSocket lifecycle, mutations, error tiers, observability                           | the **panel + marketing** frontend                 |

### Where overlapping concerns live (canonical home)

Some topics are touched by more than one area, each from its own angle. The canonical home:

- **Run lifecycle / state machine** → [`control-plane/run-state-machine.md`](./control-plane/run-state-machine.md)
  (operational states + transitions). domain-model and evaluation describe the _invariant_; they defer the state machine here.
- **Metric types** → [`contracts/leaf-schemas-experiment.md`](./contracts/leaf-schemas-experiment.md)
  for the _shapes_; [`stats/metric-types.md`](./stats/metric-types.md) for _aggregation/variance_ behavior; domain-model for the _concepts_.
- **Assignment Store** → [`evaluation/assignment-store-port.md`](./evaluation/assignment-store-port.md)
  for the _interface_; [`platform/assignment-store-substrate.md`](./platform/assignment-store-substrate.md) for the _KV/DO substrate_.
- **Exposure event row** → [`pipeline/exposure-event-contract.md`](./pipeline/exposure-event-contract.md) (the one canonical row schema; do not redefine it elsewhere).
- **Two keys (first-touch identity vs wire `dedup_key`)** → defined once in
  [`pipeline/exposure-event-contract.md`](./pipeline/exposure-event-contract.md).
- **Test-evaluation (dry-run)** → canonical envelope:
  [`contracts/request-response-envelopes-conventions.md`](./contracts/request-response-envelopes-conventions.md);
  behavior + surface: [`sdk/test-evaluation-endpoint.md`](./sdk/test-evaluation-endpoint.md)
  (the single spec for this endpoint). Reads the same KV-backed config the data plane reads.
- **Privacy lifecycle / deletion / export** → [`platform/privacy-data-lifecycle.md`](./platform/privacy-data-lifecycle.md)
  is the source of truth. Narrow storage and endpoint specs link there instead of redefining lifecycle rules.
- **Metric Event intake** → [`pipeline/metric-event-contract.md`](./pipeline/metric-event-contract.md)
  owns `track()`, explicit Entity identity, immutable Event Definition resolution, idempotency,
  admission, durable acceptance, and Experiment join compatibility.
- **Web Event capture and identity** →
  [`sdk/web-analytics-capture.md`](./sdk/web-analytics-capture.md) owns browser SDK behavior and
  adapters; [`pipeline/web-event-identity.md`](./pipeline/web-event-identity.md) owns retry, Web
  Session, optional Entity identity, and Experiment-exclusion rules.
- **Event Ingest transport** → [`pipeline/edge-ingest-contract.md`](./pipeline/edge-ingest-contract.md)
  owns the four queues, DLQs, fixed Tinybird drain governor, Admission Gate, durable acceptance, and
  write-ahead Tinybird recovery boundary. ADR-0043 records why the current direct path must be
  replaced.
- **Metric/Web physical retry collapse** →
  [`pipeline/physical-dedup-pipes.md`](./pipeline/physical-dedup-pipes.md) owns aggregate-state
  materialization, merged serving reads, performance gates, and replacement-safe repair. ADR-0045
  records why the raw logs remain truth but are not the enterprise request-time dedup path.
- **Web Analytics reads** →
  [`control-plane/endpoints-web-analytics.md`](./control-plane/endpoints-web-analytics.md) owns the
  typed Analysis Worker routes; frontend specs own only their URL and presentation behavior.
- **Agent-verifiable Done** → [`platform/agent-verification.md`](./platform/agent-verification.md)
  is the source of truth for proof commands, local Worker smoke, remote Cursor requirements, and what each
  slice must show before handoff.

## External configuration

External provider/account configuration is tracked in Linear, not in a parallel setup runbook.
Specs describe the target behavior; live setup status and remaining external blockers belong on the
owning `kind-slice` ticket. Use [`../agents/workflow/config.md`](../agents/workflow/config.md) for
tracker states, labels, and environment-safety rules.

## Next phase

These specs are written to be sliced into dependency-ordered `kind-slice` tickets (see
[`../agents/workflow/config.md`](../agents/workflow/config.md)) for remote agent implementation.
Each slice must include a `Done` section that names the exact local proof. Build order roughly follows
the dependency grain: contracts → platform/storage → domain-model → evaluation + pipeline →
control-plane + sdk → stats → frontend.
