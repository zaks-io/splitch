# Control Plane API context

Read this when touching `apps/control-plane-api`, control-plane specs, authoring endpoints, or
configuration mutations.

## Owns

- App, Environment, and Flag Configuration authoring.
- Promotion and Environment Policy gates.
- Approval Request, Review, and Confirmation.
- Credential provisioning and revocation semantics.

## Ownership and configuration terms

**App**:
A product or service surface that groups related Flags and hosts Experiments. The five runtimes of one
product share a single App: define a Flag once, consume it everywhere. An App belongs to exactly one
Organization. App is not an ownership unit. `app_id` is splitch's data-isolation seam.

An App spans one or more Environments. A Flag's definition is App-level: key, schema, full Variant
catalog, and Default Variant. A Flag's configuration is per-Environment.

Avoid: Site; Project; Tenant; Workspace; treating App as an Organization; treating App as one
environment.

**Environment**:
A named deployment context under an App, such as `dev` or `prod`. Each Environment holds its own Flag
Configuration per Flag, SDK credentials, experiment data, and Environment Policy. Control-panel URLs
scope by `/{orgSlug}/{appSlug}/{env}/...`.

Avoid: stage; tier; instance; deployment.

**Flag Configuration**:
The configuration of one Flag within one Environment: available Variant names, Targeting Rules,
rollout, and enabled state. This is the unit edited, audited, diffed, and promoted. The Flag
definition is App-level and shared; Flag Configuration is per-Environment and can diverge freely.

Avoid: env config; flag state; putting availability on the Variant itself.

**Promotion**:
Moving Flag Configuration, or a single Variant's availability, from one Environment to another. The
headline flow is build and tune in dev, then promote to prod. Promotion is deployment. Start is
measurement. Promotion is subject to the target Environment's Policy.

Avoid: deploy; ship; publish; push.

## Policy and review terms

**Environment Policy**:
The per-Environment rule set declaring, per change type, whether a change is allowed freely or must
pass a Confirmation or future approval. Change types include Variant availability,
targeting/rollout/value, enabled state, and Start an Experiment Run. Levels are `allow`, `confirm`,
and future `approve`.

All levels use the same Approval Request and Review machinery. The level only decides who may Review:
`allow` skips Review, `confirm` lets the proposer self-review, and future `approve` requires a
distinct principal.

Dev Policy is typically all `allow`. Prod Policy is the user's choice: confirm on availability only,
on value changes too, or on every production-affecting change. "Prod is more careful" is structural
and configurable, not hardcoded.

Avoid: guardrail for policy; a separate approval flow; hardcoding prod as special.

**Approval Request**:
The durable pending-change record for a Policy-gated mutation while it awaits Review. Carries the
immutable proposed-vs-current diff, target version, Policy context, proposer, status
(`pending -> applied | declined | stale`), application result, and audit trail. It exists from day
one under `confirm`, where the proposer creates and self-reviews the request in one action. Every
gated change type becomes an Approval Request: Promotion, direct Flag Configuration edit, Variant
value change, and Start an Experiment Run. This lets splitch grow into second-person approval
without a domain rewrite.

Avoid: change proposal; change request; pending change.

**Review**:
Acting on an Approval Request: `approve_and_apply` or decline. V1 has no approve-only action and no
deferred application. Who may Review is determined by Environment Policy. Under `confirm`, the
proposer may self-review. Under future `approve`, self-review is disallowed. Review authorization
and target-version validation happen before mutation; a changed target makes the request terminal
`stale`.

The Policy level is only the permission to self-review. Moving from confirm to approval is a
policy/role change, not a new pipeline.

Avoid: approval as a separate pipeline.

**Confirmation**:
The single-operator form of Review under the `confirm` Environment Policy level. It is a
self-reviewed Approval Request. Confirmation guards the commit only. It is not a draft, staged state,
or optimistic state. The kill switch is never blocked from turning a Flag off.

Avoid: treating Confirmation and approval as different mechanisms; staging; draft.

## Credential terms

The SDK credential model has two keys. Both are scoped to exactly one Environment.

**API Key**:
The secret credential a server-side SDK presents for full data-plane access. Stored as a record with
hash, scopes, and revoked state, then validated per call. Never ship it to a browser. Control-plane
surfaces provision and revoke API Keys, but do not read or paste an existing key value. Show the value
once at creation.

Avoid: using it as the client-side SDK credential.

**Client Key**:
The public, non-secret identifier a client-side SDK presents. Safe to embed in shipped client code.
It can evaluate Flags and submit strictly validated, write-only Metric Events for its App and
Environment. It cannot read full flag config, Targeting Rules, Event Definitions, Metric Events,
mint keys, or reach another App. Abuse is bounded at the edge by controls such as origin/referrer
allow-listing and rate limiting, not by hiding the value. Control-plane surfaces may retrieve and
share it freely.

Avoid: treating it as secret; using it for server-side full access.

See [`../../packages/sdk/CONTEXT.md`](../../packages/sdk/CONTEXT.md) for SDK-facing language.

## IDs and slugs

- `orgSlug` and `appSlug` exist only for human and agent-readable URLs.
- IDs such as `org_...` and `app_...` are canonical in code, data, and APIs.
- The router resolves slug to ID once at the edge. Everything below speaks IDs.
- Never key data or internal lookups on a slug.

## Related context

- Organization and membership: [`../auth-api/CONTEXT.md`](../auth-api/CONTEXT.md)
- Flag resolution and Experiment Run behavior: [`../evaluation-api/CONTEXT.md`](../evaluation-api/CONTEXT.md)
- Contract naming: [`../../packages/contracts/CONTEXT.md`](../../packages/contracts/CONTEXT.md)
- Control Plane SDK: [`../../packages/control-plane-sdk/CONTEXT.md`](../../packages/control-plane-sdk/CONTEXT.md)
