# splitch — specification

This is the **final-state source of truth** for building splitch. Read the spec; you should not
need to read the ADRs to implement. The [ADRs](../adr/) record _why_ each decision was made and
the [architecture seam docs](../architecture/) hold the longer design narrative — both are
referenced from each spec file's `## Sources`, but the spec is what you build against.

- **Context index / ubiquitous language:** [`../../CONTEXT.md`](../../CONTEXT.md). Read it first,
  then follow the domain-specific context link for the area you are touching. Use these terms exactly;
  never invent synonyms.

Each area is a directory with a thin `README.md` index and small, single-concern files
(≤165 lines) so an implementing agent reads only what its ticket touches.

## What splitch is

Unified feature flags + A/B experimentation on Cloudflare's edge, built to be agent-first and to
scale to millions of events. Two planes:

- **Data plane (hot path):** the public SDK calls the Evaluation Worker, which resolves a Variant
  (`assign()` + holdover replay) and fires an Exposure. KV serves reads; per-key Durable Objects
  serialize first-touch writes; the Event Ingest Worker appends raw events to Tinybird.
- **Control plane:** authoring (Org/App/Flag/Experiment/Run/Metric/Segment), auth (WorkOS +
  OAuth PRM + auth.md), and the MCP/CLI surfaces — all thin skins over one Zod-first typed contract. The
  analytics/stats engine reads the raw Tinybird log.

## The spine (read these first)

1. **Assignment** is a pure function `assign(Run, targetingKey) -> variantName` — never recorded.
2. **Exposure** is the only recorded event; deduped first-touch per `(Entity, Run)`; it is the
   analysis denominator.
3. **Run** is the immutable unit of analysis; its assignment config is frozen for its life.
   Assignment edits stage on a **draft** and one **Start** opens the next Run; measurement edits
   recompute in place.

## System map (seams)

```
  Public SDK ──evaluate()/peek()──▶  Evaluation Worker ────────────────────────┐
   (Client Key)                        │  reads Provider config (KV)            │
                                       │  reads AssignmentStore.getAll (KV)     │ fires
                                       │  assign() on miss / replay on holdover │ Exposure
                                       ▼                                        ▼
                              Provider (config)              Event Ingest Worker
                              AssignmentStore                 (raw log, Tinybird)
                               getAll: KV  / put: per-key DO   │ first-touch dedup (query-time)
                                       ▲ write-through          │ __multiple__ quarantine
                                       └── put (first-touch) ◀──┘ activation gate (re-anchor)
                                                                ▼
                                                         Analysis Worker
                                                          Stats engine: variance → CUPED → aCS → FDR

  Humans / Agents ──▶ Control Plane API Worker ◀── CLI + remote MCP Worker
  (WorkOS / OAuth PRM) │ Zod-first contract (@splitch/contracts → hc client)
                        │ writes config via per-App DO → KV + D1, broadcasts nudge
                        ▼
                 D1 (identity, config) · KV (hot validation, edge config) · Tinybird (events, audit)

  Panel + Marketing (TanStack Start, 2 Workers, shared ui) ── hibernating WebSocket nudges ── per-App DO
```

## Areas

| Area                               | Read it for                                                                                                                            | Canonical home of                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| [domain-model/](./domain-model/)   | the entity model, the Assignment/Exposure/Run spine, the edit taxonomy, holdover semantics                                             | the **conceptual** model + entity field tables     |
| [contracts/](./contracts/)         | Zod-first contract spine, leaf schemas, request/response envelopes, storage schemas, error model, validation policy                    | the **canonical shapes** every other area links to |
| [platform/](./platform/)           | storage map, config store, privacy lifecycle, multi-tenant isolation, the DO substrates, live-update DO, monorepo/toolchain, cron      | **where data lives** + the physical substrates     |
| [evaluation/](./evaluation/)       | `assign()`, Provider port, Assignment Store port, evaluate-path orchestration, holdover/replay, exposure firing, dry-run               | the **hot path** behavior + its ports              |
| [pipeline/](./pipeline/)           | edge ingest, exposure/activation event schema, first-touch dedup query, activation gate query, holdover write, physical Tinybird layer | the **Exposure pipeline** + event row schemas      |
| [stats/](./stats/)                 | the one CI object, variance + delta method, sequential aCS, CUPED/winsorization, SRM, FDR, dimension slicing, result shapes            | the **statistics engine**                          |
| [control-plane/](./control-plane/) | Organization tier, auth (doors + access matrix), Run state machine, the full endpoint inventory, MCP/CLI, credentials                  | the **control-plane API** + auth                   |
| [sdk/](./sdk/)                     | the public data-plane SDK surface, evaluate/peek accessors, Client-Key-safe endpoint, seen-set, five runtimes                          | the **public SDK contract**                        |
| [frontend/](./frontend/)           | appId-is-the-spine, session/loader isolation, query-key factory, WebSocket lifecycle, mutations, error tiers, observability            | the **panel + marketing** frontend                 |

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
  behavior: [`evaluation/test-evaluation-endpoint.md`](./evaluation/test-evaluation-endpoint.md) +
  SDK distinction: [`sdk/test-evaluation-endpoint.md`](./sdk/test-evaluation-endpoint.md). Reads the same KV-backed config the data plane reads.
- **Privacy lifecycle / deletion / export** → [`platform/privacy-data-lifecycle.md`](./platform/privacy-data-lifecycle.md)
  is the source of truth. Narrow storage and endpoint specs link there instead of redefining lifecycle rules.
- **Agent-verifiable Done** → [`platform/agent-verification.md`](./platform/agent-verification.md)
  is the source of truth for proof commands, local Worker smoke, remote Cursor requirements, and what each
  slice must show before handoff.

## Next phase

These specs are written to be sliced into dependency-ordered `kind-slice` tickets (see
[`../agents/workflow/config.md`](../agents/workflow/config.md)) for remote agent implementation.
Each slice must include a `Done` section that names the exact local proof. Build order roughly follows
the dependency grain: contracts → platform/storage → domain-model → evaluation + pipeline →
control-plane + sdk → stats → frontend.
