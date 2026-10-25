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

{ installationId, callbackUrl, webhookSecret, callbackVerification?: "hmac-sha256" }
```

On a first install, `callbackUrl` uses the actual `CONVEX_SITE_URL`, preserves the mounted path,
and appends `/configuration`. The component supports the default `*.convex.site` domain and custom
HTTP Actions domains without an additional origin setting. An upgrade keeps the stored callback
for an active or revoked installation, and for a pending installation with any valid callback,
including a custom domain. Only a new installation or repair of an invalid pending callback
requires URL derivation. Missing or invalid `CONVEX_SITE_URL` then fails before local initialization
or this endpoint is called.

The callback must use HTTPS on port 443, have a public DNS hostname, and end in `/configuration`.
Credentials, query strings, fragments, IP literals, single-label hosts, and private or reserved
DNS suffixes are rejected. The Control Plane also rejects `splitch.dev`, its subdomains, and its
own `splitch-control-plane-api` Workers domains. The same destination validation applies to
registration, receiver verification, and every configuration delivery.

A request with `callbackVerification: "hmac-sha256"` must complete
[receiver verification](#callback-receiver-verification) before a new installation is inserted.
This permits provider-neutral public HTTPS callbacks. A request without the capability retains
the legacy `*.convex.site` hostname rule and does not send a challenge. Splitch excludes the
request body from logs, encrypts the secret under the Control Plane Worker's required 32-byte
base64 `CONVEX_WEBHOOK_KEK`, and never returns it.

Installation requires both `data-plane:evaluate` and `data-plane:write`, unlike every other route
here. The Key mounted at install is the Component's only credential, and it authenticates Metric
Event delivery as well as evaluation. Delivery happens after the caller's Mutation has committed, so
an evaluate-only Key would let `track()` return a receipt and then send every Metric Event terminal,
unobserved. Install refuses it with `INSUFFICIENT_SCOPES` instead, while a human is watching.

An exact retry of a non-dormant installation returns the existing installation without a new
challenge and preserves its active or revoked status. A dormant installation with the verification
capability requires a fresh receiver proof before reactivation. Legacy retries without that
capability leave the dormant mark unchanged. Reusing `installationId` with a different callback or secret fails
`IDEMPOTENCY_KEY_CONFLICT` before verification. The response is:

```text
{ installationId, appId, environmentId, environmentVersion, status: "active" | "revoked" }
```

The component then pulls the snapshot. Installation is not complete locally until that snapshot is
validated and committed.

## Callback receiver verification

For a new installation that advertises the verification capability, Splitch creates a fresh UUID
challenge and posts this exact JSON shape to the callback:

```text
{ type: "callback.verify", installationId: <UUID>, challenge: <UUID> }

Splitch-Timestamp: <unix-seconds>
Splitch-Signature: v1=<hex HMAC-SHA256(timestamp + "." + exact-body)>
```

The request uses the proposed webhook secret and carries no API Key or configuration payload.
The receiver authenticates the exact body bytes, permits at most five minutes of clock skew, and
requires the challenge's installation ID to match its locally stored installation. Only the current
secret can authenticate a challenge, even during rotation; the previous secret is accepted only
for ordinary configuration nudges. The receiver returns:

```text
HTTP 204
Splitch-Callback-Proof: <hex HMAC-SHA256("callback.verify:" + installationId + ":" + challenge)>
```

Splitch compares this independent proof in constant time. A `2xx` response without the correct proof
fails verification. The challenge never raises the announced Environment version, claims a delivery
ID, or schedules configuration sync. A missing or invalid proof, redirect, or other permanent
receiver rejection returns `VALIDATION_ERROR`; transport failures, `429`, and `5xx` return
`SERVICE_UNAVAILABLE` so the component can retry. No remote installation row is written on failure.
An exact retry of a non-dormant stored installation does not need a reachable receiver.

Verification and configuration deliveries use a five-second timeout and `redirect: "manual"`.
Redirect responses fail rather than changing the destination. The Cloudflare Workers runtime
[enforces public outbound destinations at connection time](https://developers.cloudflare.com/workers/reference/security-model/),
including after DNS resolution and rebinding. Splitch denies its own domains because Workers'
own-zone origin exception would otherwise permit a private zone origin. DNS safety depends on this
Workers enforcement; hostname syntax checks alone do not enforce it in another runtime.

## Release order

Deploy the Control Plane support first, then release the SDK containing the shared callback
contracts, then release the Convex component that advertises the verification capability. This
keeps old components compatible while the server adopts verification and ensures the released
component can import its SDK dependency. Production deployment and package publication require
the applicable release approval; this order does not authorize either action.

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
and the complete latest bounded `DeliveryErrorEnvelope`. The additive, nullable
`deploymentMissingAt` timestamp identifies a dormant installation while `status` stays `active`.
The operator list, CLI `convex-installations list` output and MCP `convex_installations_list`
output expose the same field. It returns no secret or config payload.

A terminal callback `404` collects one deployment probe candidate for that owned outcome. Probing
starts only after every claimed delivery in the batch has completed, with at most six probes in
flight. Probe time never consumes a send slot or a claimed delivery's lease. Only a validated
`https://<name>.convex.site/.../configuration` callback maps to
`https://<name>.convex.cloud/version`. The probe has a five-second timeout and follows no redirects.
A `404` with a `convex-usher` header proves deletion; a `200` proves the deployment is live.
Other results, missing headers, timeouts, errors and unsupported callback hosts are inconclusive.
A callback `404` alone cannot establish deletion because a live deployment can lack that route.

A deletion result marks dormancy only if its completion receipt is still current. A newer delivery
outcome, registration, reactivation or deployment check invalidates the receipt, even when activity
shares the same timestamp. A stale probe leaves installation health and outstanding deliveries
unchanged.

Deleted deployments become dormant. Their pending and leased deliveries are suppressed, and config
commits stop inserting deliveries for them. The daily 08:00 UTC cron re-probes at most 100 active
dormant installations, oldest checked time first with installation ID as the tie-breaker. Every
attempt advances that time, including inconclusive results, so later batches rotate fairly.
The recovery batch runs at most six probes concurrently.
A live result or successful verified re-registration clears the mark and enqueues the Environment's
current version atomically. Recovery reuses an existing suppressed or terminal delivery for that
version if necessary, and repeated recovery is idempotent. Other probe results leave it dormant.
Dormant installations, including those older than 30 days, remain stored for a later retention
decision. Neither probing nor recovery revokes or deletes installations.

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
and claims `deliveryId` before scheduling sync. Splitch follows no redirects and applies the same
five-second timeout and destination restrictions as receiver verification. A non-2xx response or
transport failure enters durable retry; only `2xx` completes the delivery.

## Non-goals

- General outbound webhooks or user-authored payload templates. Custom domains are supported only
  for verified configuration receivers.
- Creating or rotating an installation, or reading its configuration snapshot, with a control-plane
  token. A control-plane token may list and revoke installations through the operator door.
- Calling any Convex integration route with a Client Key.
- Returning, recovering, or logging a stored webhook secret.

## Done

- Contract and local Worker smoke tests cover every route, credential tier, scope injection, retry,
  conflict, callback validation, redaction, ETag, revocation, and missing installation.
- Receiver fixtures prove current-secret verification, installation ID matching, independent proof,
  rejection without a remote insert, and exact retries without a challenge or status change.
- Webhook fixtures prove exact-byte signing, constant-time verification, timestamp bounds, replay
  rejection, no redirects, five-second transport bounds, callback destination restrictions, and
  complete retention of the bounded allowlisted error envelope.
- A live preview component installs, pulls, rotates, reports status, receives a change, and uninstalls.

## Sources

- [ADR-0049](../../adr/0049-convex-local-evaluation-uses-nudge-pull-sync-and-transactional-exposure-delivery.md)
- [LaunchDarkly webhook signing](https://launchdarkly.com/docs/fed-docs/api/webhooks#signing-the-webhook)
- [Cloudflare Workers security model](https://developers.cloudflare.com/workers/reference/security-model/)
- [Convex component HTTP routes](https://docs.convex.dev/components/authoring#http-actions)
- [error-responses.md](../contracts/error-responses.md)
