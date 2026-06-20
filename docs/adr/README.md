# Architecture Decision Records

Load-bearing decisions, recorded so future architecture reviews don't re-litigate them. Terse by
design — see the format in `~/.claude/skills/grill-with-docs/ADR-FORMAT.md`. Vocabulary follows
[CONTEXT.md](../../CONTEXT.md); fuller design narrative lives in
[docs/architecture/](../architecture/).

| # | Decision |
|---|----------|
| [0001](./0001-assignment-is-pure-not-an-event.md) | Assignment is a pure computation, not an event |
| [0002](./0002-run-is-the-immutable-unit-of-analysis.md) | The Run is the immutable unit of analysis |
| [0003](./0003-material-edits-including-measurement-open-a-new-run.md) | Material edits — including measurement — open a new Run |
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

0001–0006 come from the Assignment/Exposure seam grills (2026-06-20). They form a chain: 0001 (pure
assignment) enables 0006 (clean holdover predicate); 0002 (immutable Run) is enforced by 0003 (material
edits) and protected by 0006; 0004 (exposure-on-read) forces 0005 (dedup).

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
