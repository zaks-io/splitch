# Cloudflare integration Worker: durable local evaluation

`@splitch/cloudflare` is the first-party Worker deployed into a customer's Cloudflare account. One
deployment is bound to one Splitch Environment. Application Workers call it through service-binding
RPC, so no evaluation crosses the public Internet.

## Customer setup

The customer installs `@splitch/cli`, `@splitch/cloudflare`, and Wrangler 4, exports the Environment's
API Key under the exact `SPLITCH_API_KEY` name, authenticates Wrangler, and runs:

```bash
pnpm exec splitch cloudflare setup --env production
```

The command fails before mutation if the API Key, application `wrangler.jsonc`, Wrangler 4 session,
or Cloudflare account is unavailable. It then:

1. creates `.splitch/cloudflare/production/wrangler.jsonc` with the package's tested compatibility date,
   `nodejs_compat`, Workers Logs and traces, the `SPLITCH_STATE` Durable Object binding, and the V1
   SQLite migration;
2. generates an installation UUID and 32-byte integration secret using Web Crypto;
   the mode-`0600` local state file is excluded through `.gitignore`;
3. deploys `@splitch/cloudflare/worker` as `splitch-config-production` through Wrangler;
4. writes `SPLITCH_API_KEY` and `SPLITCH_PUSH_SECRET` as Wrangler secrets through stdin;
5. registers the deployment URL and secret through the API-Key integration route;
6. waits until `appliedEnvironmentVersion === environmentVersion`;
7. adds `{ binding: "SPLITCH", service: "splitch-config-production" }` to the application's selected
   Wrangler environment and runs `wrangler types`.

An exact rerun discovers and repairs the existing installation. Reusing the Environment name for a
different API Key, Cloudflare account, endpoint, or secret fails `IDEMPOTENCY_KEY_CONFLICT`.

`splitch cloudflare status --env production` returns the Worker name, endpoint, installation state,
current Environment version, applied version, pending delivery count, and latest bounded error.
`splitch cloudflare remove --env production` first revokes Splitch delivery, then removes the service
binding and integration Worker. It never deletes an unrelated Worker or untracked file.

## Application API

Wrangler-generated types make `env.SPLITCH` a typed service binding. The public RPC surface is:

```ts
interface SplitchCloudflareService {
  evaluate(flagKey: string, context: EvaluationContext): Promise<VariantValue>;
  evaluateDetails(flagKey: string, context: EvaluationContext): Promise<ResolutionDetails>;
  status(): Promise<CloudflareRuntimeStatus>;
}
```

`EvaluationContext` matches `@splitch/sdk`: `targetingKey` is required, `idType` defaults to `user`,
`attributes` defaults to `{}`, `defaultValue` defaults to `false`, and `idempotencyKey` is required.
The same call handles ordinary Flags, Targeting Rules, baseline rollouts, live Experiments, and
holdover replay. There is no `remote`, `experiment`, `sendExposure`, or fallback option.

`evaluate` returns `details.value`. `evaluateDetails` returns OpenFeature Resolution Details. Both
are Exposure-bearing accessors because an application RPC is an explicit encounter. Setup and health
checks use `status`, never an evaluation accessor.

## Durable state

The `SplitchState` SQLite Durable Object owns these tables:

- `integration`: installed App, Environment, installation ID, snapshot version, and state;
- `snapshot`: one strict complete configuration payload;
- `assignments`: one held Variant per `(experimentId, idType, targetingKeyHash)`;
- `evaluation_claims`: caller idempotency key, request fingerprint, and complete result;
- `exposure_outbox`: retry-stable Exposure payload and bounded delivery state;
- `push_claims`: accepted configuration delivery IDs.

The targeting key hash uses an installation-local HMAC key stored only in Durable Object storage.
The raw Targeting Key exists in a pending Exposure row only until the row is accepted, terminal, or
24 hours old. Terminal rows erase Entity data and retain the complete bounded error. Evaluation
claims, accepted push claims, and terminal Exposure metadata expire after 30 days, matching the
Convex integration retention policy; pending Exposure rows are never removed by retention cleanup.

An Evaluation transaction reads the current snapshot and local Assignments, resolves through
`@splitch/evaluation-core`, writes a new holdover and Exposure row when required, records the
idempotency result, and schedules the outbox alarm. Reusing an idempotency key with different input
fails loud. Retrying identical input returns the stored result and creates no second Exposure.

## Configuration push

The Worker's only public route is:

```text
POST /integrations/splitch/configuration
Splitch-Delivery-Id: <uuid>
Splitch-Timestamp: <unix-seconds>
Splitch-Signature: v1=<hex HMAC-SHA256(timestamp + "." + deliveryId + "." + exact-body)>
```

The body is the strict complete `ConfigSnapshot`. The Worker accepts at most five minutes of clock
skew, compares fixed-size signature digests in constant time, follows no redirects, and buffers only
the contract-bounded snapshot body. A valid delivery is applied before `204`; invalid auth is `401`,
invalid input is `400`, scope mismatch is `403`, and an older or duplicate version is an idempotent
`204`.

The Worker has no general proxy route, CORS surface, dashboard, or customer-authored callback. The
integration secret authenticates only Splitch configuration pushes. The Splitch API Key is used only
for server Exposure delivery.

## Exposure delivery

The Durable Object alarm sends pending rows in bounded batches to
`POST /api/integrations/cloudflare/exposures`. Splitch verifies installation scope, immutable Run
configuration hash, Evaluation Context, and resolved Variant before accepting the Exposure. A stable
Exposure ID makes retry idempotent.

`408`, `429`, `5xx`, and transport failure retry with capped deterministic jitter. Other `4xx`
responses become terminal. Accepted and deduplicated rows are deleted. A row older than 24 hours
becomes terminal and erases its Targeting Key and attributes.

## Failure behavior

- No installed snapshot returns `PROVIDER_NOT_READY` with `reason: ERROR`.
- A malformed or cross-scope snapshot is rejected without replacing good state.
- A stored snapshot below the announced minimum returns `reason: STALE`.
- A missing Flag returns `FLAG_NOT_FOUND` with `reason: ERROR`.
- Any failed resolution returns the caller's Default Variant only with explicit error metadata and a
  structured error log.
- Exposure delivery failure does not alter the resolved Variant or lose the durable outbox row.

## Done

- A clean fixture runs setup against local Wrangler, generates valid binding types, and evaluates an
  ordinary Flag and a live Experiment through the same service-binding method.
- Tests prove snapshot signature, replay, scope, monotonic version, and malformed-body handling.
- Tests prove atomic holdover, idempotency conflict, Exposure outbox creation, alarm retry, and
  verified server ingest.
- A shared-preview journey changes a Flag and a live Run, observes the new Environment version
  without polling, and confirms `environmentVersion === appliedEnvironmentVersion`.

## Sources

- [ADR-0050](../../adr/0050-cloudflare-workers-use-a-customer-owned-durable-integration-worker.md)
- [Cloudflare Worker RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)
- [Cloudflare Durable Object SQLite](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [convex-component.md](./convex-component.md), [provider-port.md](../evaluation/provider-port.md)
