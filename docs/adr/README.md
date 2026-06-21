# Architecture Decision Records

Load-bearing decisions, recorded so future architecture reviews don't re-litigate them. Terse by
design — see the format in `~/.claude/skills/grill-with-docs/ADR-FORMAT.md`. Vocabulary follows
[CONTEXT.md](../../CONTEXT.md); fuller design narrative lives in
[docs/architecture/](../architecture/).

| # | Decision |
|---|----------|
| [0001](./0001-assignment-is-pure-not-an-event.md) | Assignment is a pure computation, not an event |
| [0002](./0002-run-is-the-immutable-unit-of-analysis.md) | The Run is the immutable unit of analysis |
| [0003](./0003-material-edits-including-measurement-open-a-new-run.md) | Assignment edits open a new Run; measurement edits recompute over the existing Run |
| [0004](./0004-exposure-fires-on-read.md) | Exposure fires on read; deferral is an explicit accessor |
| [0005](./0005-exposure-dedup-first-touch-pipeline-authoritative.md) | Exposure dedup is first-touch per (Entity, Run), pipeline-authoritative |
| [0006](./0006-run-boundary-sticky-experience-counted-in-old-run.md) | Run boundary: sticky experience, counted in the old Run |
| [0007](./0007-assignment-store-is-a-sibling-seam-not-behind-the-provider.md) | The Assignment Store is a sibling seam, not behind the Provider |
| [0008](./0008-assignment-store-is-dumb-storage-policy-on-the-evaluate-path.md) | The Assignment Store is dumb storage; replay policy on the evaluate path |
| [0009](./0009-assignment-store-substrate-kv-read-do-write.md) | Assignment Store substrate: KV read, per-key Durable Object write |
| [0010](./0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md) | The Exposure pipeline is a raw append-only log, deduped at query time (ELT) |
| [0011](./0011-conflicting-variant-entities-quarantined-to-multiple.md) | A conflicting-Variant Entity is quarantined to `__multiple__`, not silently resolved |
| [0012](./0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md) | Activation gate: activation follows exposure, re-anchors the window, ships bias guardrails |
| [0013](./0013-activation-is-a-first-class-event-counterfactual-triggering-is-additive.md) | Activation is a first-class event; counterfactual triggering is additive, not a rewrite |
| [0014](./0014-stats-engine-sequential-always-valid-frequentist-by-default.md) | Stats engine default: sequential always-valid, frequentist, asymptotic confidence sequences |
| [0015](./0015-variance-delta-method-aggregate-to-randomization-unit.md) | Variance: delta method over per-Entity aggregates; no naive ratio-of-means path |
| [0016](./0016-cuped-and-winsorization-default-on-but-conditional.md) | CUPED and winsorization: default-on, but conditional on the data they require |
| [0017](./0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md) | Stack: all-Cloudflare Workers for serving + reactive control plane, Tinybird analytics system of record |
| [0018](./0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md) | Identity/operational state in D1; session + API-key validation cached in KV; audit log in Tinybird |
| [0019](./0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md) | Control-plane live updates over a hibernating WebSocket; delta-nudge, TanStack Query as the sole synced store |
| [0020](./0020-tanstack-start-for-both-control-panel-and-marketing-shared-component-layer.md) | TanStack Start for both the control panel and marketing site; one shared, interchangeable component layer |

0001–0006 come from the Assignment/Exposure seam grills (2026-06-20). They form a chain: 0001 (pure
assignment) enables 0006 (clean holdover predicate); 0002 (Run freezes *bucketing*) is enforced by 0003
(assignment edits open a new Run; measurement edits recompute) and protected by 0006; 0004 (exposure-on-read)
forces 0005 (dedup). 0003 was revised on 2026-06-20: an earlier version froze measurement into the Run too;
a best-practices audit found the reference platforms all recompute measurement losslessly and restart only on
assignment changes, so splitch adopts that pattern (the raw-log ELT design of ADR-0010 makes the recompute
nearly free).

0007–0009 come from the Assignment Store seam grills (2026-06-20), which give ADR-0006's durable holdover
state a home and a substrate: 0006 (holdover state exists) needs 0007 (it lives in a sibling Assignment
Store, forced by OpenFeature's read-only Provider contract), 0008 (that store is dumb get/put; replay
policy stays on the evaluate path), and 0009 (its substrate is Workers KV for the hot-path read + a
per-key Durable Object as the serialized first-touch writer, write-through to KV). Design narrative:
[assignment-store-seam.md](../architecture/assignment-store-seam.md).

0010–0011 come from the Exposure pipeline seam grill (2026-06-20), which specifies how the raw Exposure
stream becomes the trustworthy analysis denominator: 0010 (ELT — raw append-only log, first-touch dedup as
a re-runnable windowed query at analysis time, at-least-once + idempotent key) physically ratifies 0004/0005,
and 0011 (a same-Run multi-Variant Entity is quarantined to `__multiple__` and surfaced, not silently
first-touch-resolved) keeps a delivery/integration defect from becoming invisible arm bias. Design narrative:
[exposure-pipeline-seam.md](../architecture/exposure-pipeline-seam.md).

0012–0013 come from the Activation gate seam grill (2026-06-20) — a production decision on the final schema,
not a bootstrap stopgap. 0012 pins the gate semantics (activation must follow Exposure; the Conversion
Window re-anchors to `activation_ts`; two fail-loud bias guardrails — activated-population SRM + per-arm
activation rate — because conditioning on a Treatment-affected gate biases results the full-population SRM
can't catch). 0013 makes the future Kohavi-correct counterfactual gate **additive, not a rewrite**:
activation is a first-class logged event, so counterfactual triggering is later just a `counterfactual:true`
marker through the same log/query/anchor/SRM. Design narrative:
[activation-gate-seam.md](../architecture/activation-gate-seam.md).

0014–0016 come from the Metric analysis seam grill (2026-06-20) — the statistics engine, production defaults
on the final schema. 0014 sets the inference framework (sequential always-valid by default because users
peek and fixed-horizon then runs a 25–57% false-positive rate; frequentist; asymptotic confidence sequences
so it's one CI object with the variance stack). 0015 records the non-negotiable variance rules (aggregate to
the Entity, delta method for ratio/clustered data, no naive variance path exists). 0016 ships CUPED and
winsorization default-on but gated on the data they require. Multiple comparisons use Benjamini-Hochberg FDR
across the goal-metric × Variant family. Design narrative:
[metric-analysis-seam.md](../architecture/metric-analysis-seam.md).

0017 is the stack/scaffolding decision (2026-06-20): adopt the agent-paste shell (pnpm + Turborepo monorepo,
React 19 / TanStack / Tailwind, Hono on Workers, Biome, Vitest/Stryker, Wrangler + GitHub Actions, Sentry +
Axiom) and keep the platform **all-Cloudflare for serving and control**, with **Tinybird** as the analytics
system of record. Two stores, not three: Workers + KV/D1 + Durable Objects run both the edge hot path
(assignment/exposure) and the reactive config-authoring dashboard (a DO SSE/WebSocket fan-out over the same
KV/D1 the hot path reads — the agent-paste `ArtifactLiveUpdates`/`stream` pattern), so editing and serving
share one store and there is **no config-publish seam**. Tinybird is the physical substrate for ADR-0010's
raw append-only log; Cloudflare Analytics Engine is sampled/lossy and demoted to non-critical ops telemetry.
Convex was considered and rejected for the control plane — non-edge, a cost ceiling, and it would have forced
a Convex → KV publish seam to get config onto the edge. ADR-0009 (KV read / DO write) is untouched, now also
backing config.

0018 gives the relational layer 0017 left homeless a home (2026-06-20): users, App, membership, API keys, and
billing live in **Cloudflare D1** (reusing agent-paste's Drizzle tooling, just retargeted from Postgres);
the per-request-hot reads — session and API-key validation — are served from **KV** write-through caches, so
D1 is never on the hot path; the unbounded **audit log** goes to **Tinybird**, keeping D1 under its size
ceiling. Tenant isolation is **application-enforced** (every query scoped by `app_id` in one data-access
seam), a deliberate downgrade from agent-paste's Postgres RLS — recorded, with that seam built as the
migration boundary if DB-enforced RLS ever becomes a hard requirement.

0019 resolves ADR-0017's `SSE/WebSocket` slash for the live control plane (2026-06-20): the transport is
a **hibernating WebSocket** served by one fan-out DO per App; config writes go through that DO
(persisted-before-announced); the broadcast is a small **delta-shaped invalidation nudge**, not the config
body; and the client applies nothing — it invalidates a **TanStack Query** key and refetches truth from the
read API, keeping Query as the *sole* synced server-state store (no Redux/Zustand) and reconnect recovery
free. Hibernation is the billing argument: only WebSocket stops accruing DO Duration while idle, so the
"avoid long-lived connections" intuition is reversed.

0020 commits the frontend rendering model 0017 left open and 0019 referenced conditionally (2026-06-20):
**both the control panel and the marketing site are TanStack Start apps**, both using **TanStack Query** as
the server-state store, sharing **one interchangeable component layer** (a `ui` package on Tailwind 4
tokens) so a component built for one renders unchanged in the other. Rendering is per-route, not a framework
fork: marketing routes **prerender** to static HTML (SEO/perf) while panel routes **SSR** with
loader-seeded Query caches before ADR-0019's socket attaches. SSG-for-marketing + SPA-for-panel was rejected
as the two-toolchain wall this ADR exists to refuse; Next.js was rejected as re-litigating 0017's
router/data model rather than extending it. The two surfaces ship as **two separate Workers** (different
security postures, traffic shapes, and release cadences), isolated at the deploy boundary while still
sharing the `ui` package at build time. Start on the Cloudflare adapter is already proven in agent-paste,
so this adopts a working pattern rather than betting on an unverified one.
