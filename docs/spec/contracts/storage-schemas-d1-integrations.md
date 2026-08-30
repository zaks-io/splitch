# D1 storage schemas: Convex installations and config webhook delivery

These tables live beside authoritative App and Environment configuration so a config commit can
create its webhook deliveries in the same D1 transaction. They contain no raw API Key.

## `convex_installations`

| Column                       | Type    | Required | Meaning                                                    |
| ---------------------------- | ------- | -------- | ---------------------------------------------------------- |
| `installation_id`            | TEXT PK | yes      | Component-generated UUID                                   |
| `app_id`                     | TEXT FK | yes      | Credential-derived App                                     |
| `environment_id`             | TEXT FK | yes      | Credential-derived Environment                             |
| `callback_url`               | TEXT    | yes      | Validated `*.convex.site` component route                  |
| `secret_ciphertext`          | BLOB    | yes      | Authenticated encryption of the webhook secret             |
| `secret_key_version`         | TEXT    | yes      | Webhook KEK version used for encryption                    |
| `secret_fingerprint`         | TEXT    | yes      | Keyed fingerprint for idempotency comparison, not delivery |
| `status`                     | TEXT    | yes      | `active` or `revoked`                                      |
| `last_delivered_version`     | INTEGER | no       | Most recent acknowledged Environment version               |
| `last_delivered_at`          | TEXT    | no       | ISO 8601 acknowledgement time                              |
| `latest_delivery_error_json` | TEXT    | no       | Latest bounded `DeliveryErrorEnvelope`                     |
| `created_at`                 | TEXT    | yes      | ISO 8601                                                   |
| `updated_at`                 | TEXT    | yes      | ISO 8601                                                   |
| `revoked_at`                 | TEXT    | no       | ISO 8601                                                   |

Indexes: `(app_id, environment_id, status)` and unique
`(app_id, environment_id, installation_id)`. Callback URL is not unique because named component
instances may mount distinct paths on one Convex deployment.

Secret rotation replaces ciphertext, key version, and fingerprint in one transaction. Routine KEK
rotation rewraps ciphertext without changing the underlying secret. No read path returns plaintext.

## `config_webhook_deliveries`

| Column                | Type    | Required | Meaning                                                       |
| --------------------- | ------- | -------- | ------------------------------------------------------------- |
| `delivery_id`         | TEXT PK | yes      | Retry-stable UUID                                             |
| `installation_id`     | TEXT FK | yes      | Destination installation                                      |
| `app_id`              | TEXT FK | yes      | Denormalized deletion and lease scope                         |
| `environment_id`      | TEXT FK | yes      | Denormalized config scope                                     |
| `environment_version` | INTEGER | yes      | Monotonic committed version                                   |
| `body_json`           | TEXT    | yes      | Exact strict `ConfigChanged` JSON body, with no config values |
| `state`               | TEXT    | yes      | `pending`, `leased`, `delivered`, `terminal`, or `suppressed` |
| `attempt_count`       | INTEGER | yes      | Starts at zero                                                |
| `next_attempt_at`     | TEXT    | yes      | ISO 8601 retry eligibility                                    |
| `lease_owner`         | TEXT    | no       | Current dispatcher owner                                      |
| `lease_expires_at`    | TEXT    | no       | Expired leases are reclaimable                                |
| `last_error_json`     | TEXT    | no       | Latest bounded `DeliveryErrorEnvelope`                        |
| `created_at`          | TEXT    | yes      | ISO 8601 config commit time                                   |
| `delivered_at`        | TEXT    | no       | ISO 8601 successful acknowledgement time                      |

Unique `(installation_id, environment_version)` prevents one committed version from creating two
logical nudges for one installation. The serialized body is immutable after insert. The signature
is computed at each attempt with the installation's current secret, so rotation does not strand
pending rows.

`DeliveryErrorEnvelope` is the complete persisted diagnostic shape:

```text
{
  kind: "transport" | "http" | "internal"
  code: "DNS_ERROR" | "CONNECT_TIMEOUT" | "TLS_ERROR" | "HTTP_STATUS" |
        "DELIVERY_PREPARATION_FAILED"
  httpStatus?: integer
  retryAfterMs?: integer
  occurredAt: ISO 8601
}
```

It is an allowlisted, at-most-1-KiB UTF-8 JSON value. The dispatcher never captures a response body,
request body, callback query string, arbitrary header, stack, secret, configuration value, or Entity
data. Enum and numeric validation makes the envelope bounded before serialization, so fields are
stored completely rather than truncated.

## Commit and delivery rules

- A successful config mutation inserts one row for every active installation in the same D1
  transaction as the config change. A transaction that rolls back creates no delivery.
- Dispatch starts immediately after commit and is also recoverable by the Control Plane Worker's
  once-per-minute scheduled lease scanner.
- One delivery's preparation or transport failure is isolated from every other claimed delivery. A
  preparation failure records the delivery ID and bounded error envelope before releasing its lease;
  healthy siblings still complete and acknowledge their responses.
- Transient transport, `408`, `429`, and `5xx` failures retry after `5s`, `30s`, `2m`, `10m`, then
  `30m` with up to 20% jitter on every capped retry. A claim lease lasts 60 seconds. Other `4xx`
  responses are terminal until the installation is repaired or replaced.
- A successful newer Environment version suppresses older pending rows for the same installation;
  an already leased older delivery may finish and is harmless because the component version-gates it.
- Delivery never holds the config transaction open and never rolls back committed config.
- App deletion suppresses pending or leased rows before integration revocation. Retried workers
  re-check suppression after acquiring a lease and before sending.
- Delivered rows retain for 30 days. Terminal and suppressed rows retain the complete bounded
  non-secret diagnostic envelope for 30 days. A pending or leased row is never expired.

## Done

- Migration tests cover constraints, indexes, secret redaction, rotation, and additive deployment.
- Transaction tests prove config rollback creates no row and one committed version creates exactly
  one logical row per active installation.
- Lease tests prove crash recovery, concurrent claim exclusion, suppression, retry, and retention.

## Sources

- [ADR-0049](../../adr/0049-convex-local-evaluation-uses-nudge-pull-sync-and-transactional-exposure-delivery.md)
- [convex-integration-api.md](../sdk/convex-integration-api.md)
- [privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
