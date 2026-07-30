# splitch vision

The north star. If you're researching, planning, or unsure which way a decision
should go, read this first and resolve toward it. Its job is to keep everyone
pointed the same way so we don't drift into bloat or build things that don't
serve the goal.

## What splitch is for

splitch is **unified feature flags and A/B experimentation built for agents
first**, running on Cloudflare's edge and built to scale to millions of events.

It exists to be a flagging and experimentation platform an AI agent can operate
end to end (create a flag, target it, run an experiment, read a trustworthy
result) with the same capability a human gets, and a UX that is genuinely good
_for the agent_, not a human tool the agent is forced to puppet.

We are building the best product we can for agents to use. If people want to use
it too, they can, and the human CLI and panel are first-class, but the agent is
the audience we design for. "Agent-first" is a **must**, not a label.

## Stay focused

A narrow surface done excellently beats a wide surface done adequately. We
support a deliberately limited set of things and support them _very_ well. When
a feature, abstraction, or seam doesn't clearly serve the goals below, the
default answer is no. That restraint is the point of this document.

## What "good" means here

These are the properties that define the product. Each maps to an enforced
contract, not a hope.

### Agent-first, with real parity

An agent must be able to do **everything** it needs to do, through a surface
shaped for an agent. The remote MCP server is the primary agent door; the CLI is
the primary human door; both are thin parity skins over one typed Control Plane
SDK so capability never drifts between them
([ADR-0023](./adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)).
An agent is never a second-class or limited principal. It acts _as_ a real user,
with exactly that user's authority, no more and no less
([ADR-0022](./adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)).
Good agent UX means typed tools, discoverable surfaces, errors an agent can act
on, and a login handshake that happens in-band with zero install.

### Enterprise scale

Built to scale to enterprise volumes (millions of evaluation requests) on
Cloudflare's edge. The hot path is a read-optimized data plane (KV reads,
per-key Durable Objects serializing first-touch writes, durable queue-backed
Tinybird microbatches) kept entirely separate from the control plane. The
current direct one-row Tinybird transport is known implementation debt tracked
by [ADR-0043](./adr/0043-event-ingest-will-use-durable-queue-backed-tinybird-microbatches.md)
([ADR-0017](./adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md),
[ADR-0018](./adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)).

### Statistical rigor: the data must never lie

A result must always be traceable back to the facts that produced it. The
statistics are not best-effort:

- **Sequential, always-valid inference by default.** You can look at a running
  experiment at any time without inflating false positives
  ([ADR-0014](./adr/0014-stats-engine-sequential-always-valid-frequentist-by-default.md)).
- **One honest variance path:** the delta method aggregated to the
  randomization unit. No naive variance path exists to be reached for by mistake
  ([ADR-0015](./adr/0015-variance-delta-method-aggregate-to-randomization-unit.md)).
- **CUPED + winsorization on by default but conditional**, SRM and FDR built in
  ([ADR-0016](./adr/0016-cuped-and-winsorization-default-on-but-conditional.md)).
- **Exposure is the only experiment denominator**, deduped first-touch. Metric Events supply
  values but never replace or narrow that denominator, and Web Events remain separate browser
  telemetry. The result is computed from raw, auditable, append-only facts, not a derived rollup
  you have to trust
  ([ADR-0010](./adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md)).
- **Statistical rigor is an enforced product contract**, not a setting a user can
  silently defeat
  ([ADR-0030](./adr/0030-statistical-rigor-is-an-enforced-product-contract.md)).

We follow industry-standard statistical practice as the floor and only diverge
deliberately, with the reason recorded, never a stricter default baked in
silently.

### Fail loud: no silent fallback

A failure is always observable. We never disguise a defect as a default: bad
config fails loud, conflicting variant assignments are quarantined to
`__multiple__` rather than silently resolved, an unknown identity provider is
rejected rather than trusted, and evaluation returns an OpenFeature resolution
detail rather than a silent fallback value
([ADR-0036](./adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md)).
If something is wrong, you will see it.

### Privacy by design

Privacy is a first-class concern, enforced as a contract. Data has a declared
lifecycle; no store accumulates forever by default; retention is a stated policy
per store, not an accident
([ADR-0032](./adr/0032-privacy-data-lifecycle-is-an-enforced-product-contract.md)).
Tenant isolation is enforced in one application seam
([ADR-0018](./adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)).

### Security as a contract

Security is an enforced CI and product contract, not an afterthought: trust
boundaries, supply-chain integrity, and continuous scanning against `main`
([ADR-0034](./adr/0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md),
[ADR-0035](./adr/0035-security-automation-and-supply-chain-integrity-are-an-enforced-ci-contract.md)).
See [`docs/spec/platform/security-model.md`](./spec/platform/security-model.md).

## How we decide

When a choice is ambiguous, these are the tie-breakers. They point at _what_ to
build, so they live here. The rules for _how_ we build (production-ready and
progressive, no rewrites, self-cleaning, when to add a seam) live in the specs
and plans, not the vision.

- **Best practices over cleverness.** Start from a proven standpoint; don't
  reinvent the wheel. We default to the conventional, industry-standard model and
  diverge only when a real problem the standard can't solve forces it. If every
  reference platform does X and splitch does Y, that's a flag to justify or
  reverse, not a feature to brag about.

- **Default to the industry floor; opinions are opt-in.** Our stricter opinions
  ride _on top_ of the reference-platform default as modes a user turns on, never
  baked in for everyone.

- **Fail loud over silent.** When two options exist, take the one that surfaces a
  defect as a visible signal over the one that quietly resolves it.

## Where to go next

- [`CONTEXT.md`](../CONTEXT.md): the ubiquitous language. Read it first.
- [`docs/spec/`](./spec/): the implementation source of truth.
- [`docs/adr/`](./adr/): why each decision was made.
- [`docs/architecture/`](./architecture/): the longer design narratives.
