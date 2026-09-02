# Convex integration API: installation, config snapshots, and webhook lifecycle

The Convex Component uses one API Key for one Splitch Environment. These routes are data-plane
integration routes, not control-plane CRUD, and derive App and Environment exclusively from that
credential. Client Keys cannot call them.

## Installation

The component generates a UUID `installationId` and 32 random bytes of `webhookSecret`, stores both
in its private component tables, then calls:

```text
POST /api/integrations/convex/installations
Authorization: Bearer <apiKey>

{ installationId, callbackUrl, webhookSecret }
```

`callbackUrl` combines the canonical deployment name from `CONVEX_CLOUD_URL` with the mounted
component path from `CONVEX_SITE_URL`, then appends `/configuration` on the resulting HTTPS
`*.convex.site` URL. IP literals, credentials, query strings, fragments,
nonstandard ports, redirects, and other hosts fail validation. Splitch excludes the request body
from logs, encrypts the secret under the Control Plane Worker's required 32-byte base64
`CONVEX_WEBHOOK_KEK`, and never returns it.

Installation requires both `data-plane:evaluate` and `data-plane:write`, unlike every other route
here. The Key mounted at install is the Component's only credential, and it authenticates Metric
Event delivery as well as evaluation. Delivery happens after the caller's Mutation has committed, so
an evaluate-only Key would let `track()` return a receipt and then send every Metric Event terminal,
unobserved. Install refuses it with `INSUFFICIENT_SCOPES` instead, while a human is watching.

An exact retry returns the existing installation. Reusing `installationId` with a different
callback or secret fails `IDEMPOTENCY_KEY_CONFLICT`. The response is:

```text
{ installationId, appId, environmentId, environmentVersion, status: "active" }
```

The component then pulls the snapshot. Installation is not complete locally until that snapshot is
validated and committed.

## Configuration snapshot

```text
GET /api/integrations/convex/snapshot
Authorization: Bearer <apiKey>
If-None-Match: "<environmentVersion>"  // optional
```

The strict `ConfigSnapshot` shape is owned by
[convex-component.md](./convex-component.md#configuration-snapshot). The route returns `200` with
the current snapshot and version ETag, or `304` only when the component already holds that exact
version. The request has no App, Environment, field-selection, or public-cache parameters.

## Secret rotation

The component creates and temporarily accepts a second secret, then calls:

```text
POST /api/integrations/convex/installations/:installationId/secret-rotations

{ rotationId, webhookSecret }
```

Splitch atomically replaces the encrypted delivery secret. An exact `rotationId` retry is safe;
different content fails `IDEMPOTENCY_KEY_CONFLICT`. After the response, the component removes the
old secret. If the response is lost, it accepts both secrets and retries until Splitch confirms the
rotation. The old secret is never sent back or recoverable from either API.

## Status and uninstall

`GET /api/integrations/convex/installations/:installationId` returns status, callback URL, current
Environment version, last delivered version/time, pending count, oldest pending age, terminal count,
and the complete latest bounded `DeliveryErrorEnvelope`. It returns no secret or config payload.

`DELETE /api/integrations/convex/installations/:installationId` first marks the installation revoked and
suppresses every undelivered row, then returns `204`. It is idempotent. The component deletes local
state only after revocation is acknowledged; App deletion uses the terminal-nudge flow in
[convex-component.md](./convex-component.md#deletion-and-uninstall).

## Webhook request

Splitch posts the exact serialized `ConfigChanged` body from
[convex-component.md](./convex-component.md#signed-webhook-nudge) with:

```text
Splitch-Delivery-Id: <deliveryId>
Splitch-Timestamp: <unix-seconds>
Splitch-Signature: v1=<hex HMAC-SHA256(timestamp + "." + exact-body)>
```

The receiver compares the signature in constant time, permits at most five minutes of clock skew,
and claims `deliveryId` before scheduling sync. Splitch follows no redirects. A non-2xx response or
transport failure enters durable retry; only `2xx` completes the delivery.

## Non-goals

- General outbound webhooks, custom destinations, or user-authored payload templates.
- Creating or rotating an installation, or reading its configuration snapshot, with a control-plane
  token. A control-plane token may list and revoke installations through the operator door.
- Calling any Convex integration route with a Client Key.
- Returning, recovering, or logging a stored webhook secret.

## Done

- Contract and local Worker smoke tests cover every route, credential tier, scope injection, retry,
  conflict, callback validation, redaction, ETag, revocation, and missing installation.
- Webhook fixtures prove exact-byte signing, constant-time verification, timestamp bounds, replay
  rejection, no redirects, and complete retention of the bounded allowlisted error envelope.
- A live preview component installs, pulls, rotates, reports status, receives a change, and uninstalls.

## Sources

- [ADR-0049](../../adr/0049-convex-local-evaluation-uses-nudge-pull-sync-and-transactional-exposure-delivery.md)
- [LaunchDarkly webhook signing](https://launchdarkly.com/docs/fed-docs/api/webhooks#signing-the-webhook)
- [Convex component HTTP routes](https://docs.convex.dev/components/authoring#http-actions)
- [error-responses.md](../contracts/error-responses.md)
