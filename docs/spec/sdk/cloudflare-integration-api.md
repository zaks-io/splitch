# Cloudflare integration API: registration, push health, and Exposure delivery

Cloudflare integration routes require an API Key bound to exactly one App and Environment. Client
Keys and control-plane sessions cannot call them. App and Environment never come from the body.

## Registration

```text
POST /api/integrations/cloudflare/installations
Authorization: Bearer <apiKey>

{ installationId, endpoint, pushSecret }
```

`endpoint` must be an HTTPS `*.workers.dev` hostname with the fixed
`/integrations/splitch/configuration` path. Credentials, query strings, fragments, redirects,
nonstandard ports, IP literals, and non-Cloudflare hosts fail validation. Splitch excludes the body
from logs, encrypts `pushSecret` under the required integration key-encryption key, and never returns
it.

An exact retry returns the existing installation. Reusing `installationId` with different content
fails `IDEMPOTENCY_KEY_CONFLICT`. Registration creates a delivery for the current Environment version
before returning:

```text
{ installationId, appId, environmentId, environmentVersion, status: "active" }
```

## Status and removal

`GET /api/integrations/cloudflare/installations/:installationId` returns endpoint, status, current
Environment version, last applied version/time, pending count, oldest pending age, terminal count,
and the latest complete bounded delivery error. It returns no secret or configuration payload.

`DELETE /api/integrations/cloudflare/installations/:installationId` revokes the installation and
suppresses every pending delivery before returning `204`. It is idempotent.

## Snapshot delivery

A committed configuration version atomically creates one outbox row for every active installation.
The row contains scope and version, not the full server configuration. At dispatch, Splitch builds a
strict snapshot at least as new as the target version and signs the exact body. A successful newer
snapshot suppresses obsolete pending versions for that installation.

The dispatcher starts after successful mutation responses and a once-per-minute scheduled scanner
recovers missed or failed attempts. It follows no redirects. Transport failure, `408`, `429`, and
`5xx` retry with bounded exponential backoff. Other `4xx` responses are terminal.

## Exposure delivery

```text
POST /api/integrations/cloudflare/exposures
Authorization: Bearer <apiKey>

{ exposures: CloudflareServerExposure[] }
```

The request and result shapes match the verified local-integration Exposure contract used by Convex,
with source kind `cloudflare`. Each item includes installation ID, Flag key, Experiment and Run IDs,
immutable `runConfigHash`, Evaluation Context, Variant name, and encounter timestamp. Splitch requires
an active Cloudflare installation in credential scope, recomputes the resolution against the
immutable Run, and accepts only an exact match.

## Done

- Contract and Worker tests cover credential tier, scope derivation, strict endpoint validation,
  idempotent registration, conflict, status redaction, initial delivery, and removal.
- Delivery tests cover exact-byte signing, constant-time verification fixture, no redirects,
  immediate dispatch, scheduled recovery, stale delivery coalescing, and bounded complete errors.
- Exposure tests cover active installation, immutable Run verification, mismatch rejection,
  retry-stable IDs, deduplication, and holdover repair.

## Sources

- [ADR-0050](../../adr/0050-cloudflare-workers-use-a-customer-owned-durable-integration-worker.md)
- [cloudflare-worker.md](./cloudflare-worker.md)
- [error-responses.md](../contracts/error-responses.md)
