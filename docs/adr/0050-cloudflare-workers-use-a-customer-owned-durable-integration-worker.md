# Cloudflare Workers use a customer-owned durable integration Worker

**Status:** accepted

Cloudflare Workers cannot keep a process-local configuration stream alive across isolates. Workers
KV accepts direct external writes, but its globally cached reads are eventually consistent and can
remain stale after a write. KV also cannot provide the transactional Assignment Store and Exposure
outbox required by Splitch Experiment semantics. Treating Experiment-controlled Flags differently
from other Flags would make the SDK surface fast but incorrect.

## Decision

1. **Splitch ships `@splitch/cloudflare` as a deployable integration Worker.** One generated Worker
   represents one Splitch Environment. Customer application Workers call its typed
   `WorkerEntrypoint` over a Cloudflare service binding. They do not call Splitch or a public URL at
   evaluation time.

2. **One SQLite Durable Object is the Environment integration's correctness boundary.** It stores
   the current validated full configuration snapshot, local holdover Assignments, evaluation
   idempotency claims, and the Exposure delivery outbox. Snapshot application and evaluation writes
   are atomic Durable Object transactions. KV is not authoritative and is absent from V1.

3. **Flags and Experiments have one evaluation path.** `evaluate` and `evaluateDetails` use the same
   runtime-neutral evaluator and local Assignment Store for every Flag. An Experiment creates its
   holdover and Exposure outbox row in the same transaction as its resolution claim. No Flag type
   changes method, fallback, or transport.

4. **Configuration is a signed full-snapshot push.** Every committed Environment configuration
   version creates a durable Splitch delivery row. Splitch signs the timestamp, delivery ID, and
   exact snapshot body, then posts it to the generated Worker's fixed configuration endpoint. The
   Worker verifies the signature and scope before atomically applying a strictly newer snapshot.
   Duplicate and older deliveries are idempotent. A once-per-minute scanner recovers failed pushes;
   successful mutations also start delivery immediately after commit. There is no polling.

5. **Exposure delivery is durable and server-verified.** The Durable Object alarm sends pending
   Exposures to a Splitch endpoint that accepts server-side API Keys only. Splitch reloads the immutable Run, recomputes the
   resolution, and rejects a mismatched Variant or configuration hash. Accepted and deduplicated
   rows are deleted. Retryable failures remain in the outbox for bounded retry.

6. **Setup is one CLI command.** `splitch cloudflare setup --env <name>` uses the exact
   `SPLITCH_API_KEY` environment variable and the customer's authenticated Wrangler session. It
   generates an integration secret, deploys the integration Worker, stores both secrets with
   Wrangler, registers the endpoint, waits for the first applied snapshot, and adds the service
   binding to the selected application `wrangler.jsonc`. Secrets never appear in arguments, config,
   output, or logs.

7. **Known stale or unavailable state fails loud.** Missing configuration, an invalid snapshot, an
   unapplied announced version, or unavailable Durable Object state returns Resolution Details with
   `reason: ERROR` or `STALE`. It never reports the caller's Default Variant as a successful
   resolution.

## Considered options

- **Direct Splitch writes to customer KV** were rejected because propagation is eventually
  consistent and KV cannot implement Assignment holdover or transactional Exposure delivery.
- **Local Flags plus remote Experiments** were rejected because one SDK method would have two
  latency, availability, and correctness models.
- **A customer-authored webhook receiver** was rejected because it exposes cryptography, storage,
  migrations, and retry behavior as integration work.
- **Splitch holding a broad Cloudflare API token** was rejected for V1. The customer deploys through
  Wrangler; Splitch receives only the narrow integration endpoint and generated signing secret.

## Consequences

- The generated integration Worker adds one internal service-binding call and one Durable Object
  call to evaluation. This is the price of strong local Assignment semantics in an isolate-based
  runtime.
- One Environment is one coordination atom in V1. Capacity and placement are observable, and a
  future sharded design must preserve the same public binding contract and cross-Run holdover.
- Configuration becomes usable when the push is durably applied, not merely when the control-plane
  mutation commits. Status exposes both versions so deployment gates can wait for equality.
- Customer application code has no API Key, webhook handler, KV namespace, or public Splitch call.

## Sources

- [Cloudflare Workers service-binding RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)
- [Cloudflare Durable Object rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [ADR-0004](./0004-exposure-fires-on-read.md), [ADR-0007](./0007-assignment-store-is-a-sibling-seam-not-behind-the-provider.md),
  [ADR-0036](./0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md),
  [ADR-0049](./0049-convex-local-evaluation-uses-nudge-pull-sync-and-transactional-exposure-delivery.md)
