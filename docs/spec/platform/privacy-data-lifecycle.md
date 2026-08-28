# Privacy data lifecycle: export, deletion, retention, and redaction

This is the cross-cutting contract for privacy requests. It defines what data exists, who controls it,
how Splitch exports or deletes it, and what is retained for legal or security reasons.

This is a product baseline for compliance work, not legal advice. As of 2026-06-21, California's CCPA
baseline includes rights to know/access, delete, correct, opt out of sale/sharing, limit sensitive
personal information use, notice, and non-discrimination. Delete/correct/know requests must be
acknowledged within 10 business days and answered within 45 calendar days, with one 45-day extension
after notice. Opt-out and limit requests must be honored as soon as feasible, no later than 15 business
days.

**Implementation status:** `@splitch/privacy` mints a random App `app_entity_identity_key` per
identity epoch and keeps routine root/wrapper rotation from changing that key. Evaluation and Event
Ingest persist wrapped epochs in CONFIG_STORE through the required serialized writer RPC. Assignment
holdover reads, Metric Event exact retries, export, deletion, and analysis joins resolve retained
epochs during ordinary operation. A compromised-key reset blocks all current and retained identity
reads, records real per-store proofs in one serialized workflow, destroys the old epochs only after
every proof exists, and then activates one replacement epoch. Durable rows use a non-secret version
prefix as a routing label; the HMAC key for current writes is the stored App identity key, not a
root-derived salt.

## Privacy roles

| Data class              | Examples                                                                                 | Role                                                       | Durable stores                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Control-plane User data | WorkOS user ID, email in WorkOS, memberships, sessions, device-flow tokens               | Splitch-controlled                                         | WorkOS, D1 IDs, KV sessions, keychain/CLI                                                                         |
| Organization/App config | Orgs, Apps, Environments, Flags, Experiments, Metrics, Segments, credential metadata     | Customer-controlled                                        | D1, KV config cache, per-App DO                                                                                   |
| Entity data             | Targeting Key, idType, Exposures, Activations, Metric Events, Assignment Store holdovers | Customer-controlled; Splitch is processor/service provider | Tinybird raw/derived data, KV, Assignment Store DO, customer Convex component outbox, ingest recovery/queues/DLQs |
| Browser analytics data  | Web Events, Web Sessions, optional Entity identity                                       | Customer-controlled; Splitch is processor/service provider | Tinybird `web_events` plus retry state, ingest recovery/queues/DLQ                                                |
| Audit/security data     | control-plane mutation audit, auth door, actor ID, request logs                          | shared legal/security record                               | Tinybird audit log, D1 privacy request log                                                                        |
| Observability data      | errors, traces, structured logs                                                          | Splitch-controlled operations data                         | Sentry, Axiom, Cloudflare logs                                                                                    |
| Billing data            | plan, Stripe customer/subscription IDs, invoices                                         | Splitch-controlled billing data                            | D1, Stripe when enabled                                                                                           |

## Browser analytics identity

The browser SDK's default Web Session identifier is a cryptographically random UUID v4 stored only
in `sessionStorage`. It survives same-tab navigation and reloads and ends when the tab closes.
Splitch does not create an analytics cookie, persistent `localStorage` identity, browser
fingerprint, or cross-site/cross-device identifier. Event Ingest stores only the
App/Environment-scoped `session_id_hash`, never the wire UUID.

Creating a normal SDK client does not read or write `sessionStorage`, inspect the DOM, register
browser instrumentation, or emit Web Events. Manual collection begins only when application code
calls `sdk.web.track()`. Automatic collection begins only through `sdk.web.instrument()` with a
bounded capture list. Automatic capture never reads form values, DOM text, or raw URLs.

The browser SDK buffers pending Web Events only in memory. It does not persist event payloads,
generated event IDs, or retry state in IndexedDB, `localStorage`, `sessionStorage`, cookies, or
another browser store. `sessionStorage` contains only the default Web Session identifier.
Unaccepted buffered events may be lost when the page terminates and are not restored on the next
load.

Web Analytics registers queue-flush visibility and page-lifecycle listeners only while the queue is
non-empty. Its flush timer has the same lifetime; it does not create an idle heartbeat or background
request. Calling `sdk.web.instrument()` may register only the explicitly selected automatic source
listeners.

Each instrumentation call returns a scoped cleanup function. Cleanup removes that handle's browser
listeners when the adapter supports teardown, detaches every adapter subscription, and discards its
unflushed automatic events without affecting manual events or other instrumentation handles. It
cannot revoke an event already in flight or accepted by ingest.

The `web_vital` adapter uses one lazy page-lifetime `web-vitals` collector because the library does
not expose observer teardown. A stopped handle has no subscription to it. With no subscribers, the
collector creates no Web Event, does not access Web Session storage, retains no Splitch event
payload, and performs no network I/O. The SDK never registers a second collector on reinstrumentation.

The `browser_error` adapter records only the bounded signal kind and normalized built-in exception
type. It never reads or emits messages, stacks, filenames, source URLs, rejection values,
breadcrumbs, DOM state, or arbitrary exception properties.

The SDK may copy only a valid active OpenTelemetry `traceId` and `spanId` onto a Web Event for
correlation. It does not initialize tracing or copy trace state, flags, attributes, resources,
events, links, status, or instrumentation scope. Trace correlation never creates Entity identity.

Web Event rejection and background-delivery logs contain only event ID, event name, capture source,
canonical error code, schema issue paths, transport status, and batch item count as applicable. They
never contain event values, Dimensions, Web Session or Entity identity, Targeting Key hashes, trace
context, request bodies, or response bodies.

The SDK permits only one active owner for each browser instrumentation source. Conflicting
registration fails before adding any adapter subscription or handle-owned listener, preventing
duplicate collection from overlapping handles.

An application may explicitly provide a canonical lowercase UUID for consent-aware cross-tab or
cross-domain continuity. Arbitrary strings are rejected before a claim or write. Splitch never
discovers or imports an identifier from application cookies or storage automatically.

## Entity privacy identity

The public API still accepts the **Targeting Key**. Durable Entity stores MUST use a derived
`targeting_key_hash`, not the raw value:

```text
targeting_key_hash = HMAC_SHA256(app_entity_identity_key, id_type + ":" + targetingKey)
```

Rules:

- `app_entity_identity_key` is random, secret, App-scoped, and stored outside Tinybird.
- The App-scoped Config Store Durable Object is the sole authority for the wrapped identity atom,
  lifecycle, and reset checkpoints. Hosted Evaluation and Event Ingest read it through that
  Durable Object and never accept a CONFIG_STORE replica for identity decisions.
- The identity key is immutable for one App identity epoch so Exposures, Assignments, Metric Events,
  and Entity-identified Web Events continue to join across retries and retention windows.
- Routine secret rotation rotates or rewraps the key-encryption key while preserving the underlying
  App identity key and therefore the pseudonym.
- Replacing a compromised App identity key is an explicit destructive App-wide privacy reset. It
  blocks App traffic and reads, Ends active Runs, revokes SDK credentials, suppresses and purges all
  queued delivery, and deletes every App Assignment, idempotency claim, event row, deduped snapshot,
  aggregate state, rollup, and result input before the old key is destroyed. It also purges
  old-epoch `entity_deletions` rows and rewrites Entity `privacy_requests.subject_ref` hash arrays to
  `redacted:app-identity-reset`. The reset includes anonymous Web Events because their Web Session
  pseudonyms use the same key. No old-epoch identity-bearing row may remain.
- The replacement key starts a new identity epoch only after every store-specific purge checkpoint
  passes. The App requires explicit credential re-issuance before Evaluation or ingest resumes.
- Entity export/delete computes the stable `targeting_key_hash` for the active identity epoch and
  every retained prior epoch, including historical `v1:` and `local-v1:` prefixes, until those rows
  expire. A destructive reset does not retain those keys: it purges the rows and then destroys every
  old epoch. Requests accepted before reset complete through that mandatory App-wide purge.
- The raw Targeting Key is used in memory for `assign()`, Condition matching, or Metric/Web Event
  HMAC derivation, then discarded.
- A customer-installed Convex Component may retain the raw Targeting Key and Evaluation Context only
  in its isolated pending Exposure outbox. Acceptance deletes the payload immediately; terminal
  delivery deletes raw identity/context within 24 hours and retains non-identifying failure metadata
  for 30 days. Local holdovers and pending outbox rows use
  `HMAC(componentIdentityKey, idType + ":" + targetingKey)` as their component-local deletion
  selector and never store the raw Targeting Key outside the pending payload. The component's Entity
  deletion mutation derives that selector from the request, suppresses matching delivery before
  purge, and rechecks state immediately before every send. This hash never leaves the component and
  is distinct from the App-scoped server `targeting_key_hash`.
- KV keys, DO names, Tinybird rows, Axiom fields, Sentry payloads, and audit details never contain the
  raw Targeting Key or raw Evaluation Context attributes.
- Data subject requests take `{ app_id, id_type, targetingKey }`; the Control Plane API Worker computes
  the stable `targeting_key_hash` server-side.

## Privacy request ledger

D1 owns a bounded `privacy_requests` table:

| column                    | meaning                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `request_id`              | ULID                                                                                                  |
| `org_id`                  | Organization receiving the request                                                                    |
| `app_id`                  | nullable; present for App/Entity requests                                                             |
| `request_type`            | `access` \| `export` \| `correct` \| `delete` \| `opt_out_sale_share` \| `limit_sensitive`            |
| `subject_type`            | `user` \| `organization` \| `app` \| `entity`                                                         |
| `subject_ref`             | WorkOS user ID, org/app ID, Entity-hash array, or `redacted:app-identity-reset`                       |
| `subject_ref_redacted_at` | nullable; set only when destructive identity reset irreversibly replaces an Entity-hash `subject_ref` |
| `requested_by`            | WorkOS user ID of the requester                                                                       |
| `status`                  | `received` \| `verifying` \| `processing` \| `completed` \| `denied`                                  |
| `received_at`             | server timestamp                                                                                      |
| `ack_due_at`              | received_at + 10 business days                                                                        |
| `response_due_at`         | received_at + 45 calendar days, extendable once                                                       |
| `completed_at`            | nullable                                                                                              |
| `denial_reason`           | nullable; policy/legal reason only                                                                    |

The ledger stores hashes and IDs, not email, raw Targeting Keys, or raw Evaluation Context attributes.
Keep it for at least 24 months or the contractually configured audit period, whichever is longer.
For a destructive App identity reset, an Entity request retains its non-identifying audit metadata
but irreversibly replaces the hash array in `subject_ref` with
`redacted:app-identity-reset` and stamps `subject_ref_redacted_at`. The old pseudonym is not retained
in the ledger, audit details, logs, or reset evidence.

## Export contracts

Exports are asynchronous jobs with a signed, expiring download URL. Raw secrets are never exported.

| Export              | Included                                                                                                                                   | Excluded                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| User export         | WorkOS profile, org/app memberships, sessions, issued tokens metadata, audit entries where actor                                           | API Key raw values, other users' data          |
| Organization export | Org, Apps, Environments, config, credential metadata, members, audit log, billing metadata                                                 | raw API Key values, processor-internal secrets |
| App export          | Flag/Experiment/Event Definition/Metric/Segment config, Runs, results, credential metadata, audit rows                                     | other Apps in the Org                          |
| Entity export       | rows matching `targeting_key_hash` in Assignment Store, raw events, Activation/Metric/Web states, deduped Exposure snapshot, result inputs | raw Targeting Rules for non-admin requesters   |

Entity exports are scoped by App and idType. They include the categories, sources, purposes, and
processors for the data, not only the physical rows.
Entity-identified Web Events with the same `targeting_key_hash` are included.

## Deletion contracts

Deletion is a two-phase job: stop future use first, then hard-purge every store that can hold the data.

| Deletion                | Immediate action                                                    | Purge action                                                                                                       |
| ----------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| User                    | revoke sessions, refresh tokens, CLI/MCP tokens; remove memberships | delete or disable WorkOS user; remove D1 memberships; replace actor display with deleted-user tombstone            |
| Personal Organization   | revoke all SDK credentials and stop ingest/evaluate                 | purge all Apps, config, KV, DO state, Tinybird data, WorkOS org                                                    |
| Enterprise Organization | require owner approval and SSO/billing checks                       | same as personal Org after approval; preserve contracted audit records                                             |
| App                     | revoke App credentials; block SDK evaluate/ingest                   | purge D1/KV config, Assignment Store, event rows, Exposure snapshots, retry states, rollups, audit read visibility |
| Entity                  | insert `entity_deletions` tombstone and exclude from analysis       | delete Assignment Store key/DO row and Tinybird rows matching `targeting_key_hash`                                 |

`entity_deletions` contains `{ app_id, id_type, targeting_key_hash, delete_before_ts, requested_at,
completed_at }`. The Analysis Worker MUST exclude rows where `server_received_at <= delete_before_ts` as soon as
the tombstone is committed, even before Tinybird hard purge finishes. New events for the same Targeting
Key after `delete_before_ts` are treated as newly collected customer data.

App deletion immediately suppresses every pending outbox publication, primary-queue delivery,
write-ahead Tinybird attempt, indeterminate reconciliation, `poison_pending`, `poison_transferred`,
and manual DLQ replay
for that `app_id`. Entity deletion applies the same suppression to queued, attempting,
indeterminate, or replayed rows carrying the matching `(app_id, id_type,
targeting_key_hash)` at or before `delete_before_ts`. Event Ingest consumers and operator replay
tools must recheck the current deletion suppression before Tinybird publication; a suppressed row is
acknowledged or purged without append. Deletion cannot be marked complete until matching outbox,
indeterminate state, and both poison states are purged and the bounded primary-queue/DLQ retention or
equivalent purge evidence proves no matching delivery can re-enter Tinybird.

Entity deletion redacts matching ingest claims and removes their canonical payloads, but it retains
a payload-free suppression claim containing only the family-scoped `dedup_key`, payload fingerprint,
original Event Definition IDs, and deletion state for at least the event family's maximum retention
window. An exact stale retry returns the original duplicate result without queue publication; reuse
with different content remains `EVENT_ID_CONFLICT`. The suppression claim carries no Targeting Key,
Targeting Key hash, Web Session identifier, event fields, Dimensions, or trace context. This
prevents an old retry from recreating a deleted logical fact after its original outbox and Tinybird
rows are purged.

Audit/security rows are not used for product analytics or targeting. If retained under legal/security
exceptions, read surfaces show a deleted-user tombstone instead of a name or email.

## Store checklist

Every delete job must record per-store status for:

- WorkOS: user, Organization, SSO/SCIM state.
- D1: Organization/App/config/membership/credential metadata/privacy ledgers, including destructive
  reset purge of old-epoch `entity_deletions` and irreversible Entity `subject_ref` redaction.
- KV: sessions, credential caches, config cache, liveRun keys, Assignment Store read keys.
- Durable Objects: per-App identity atoms and live-update state, Assignment Store writer rows,
  ingest claims/outbox
  payloads, Admission Gate state, write-ahead Tinybird attempts, indeterminate records, and
  `poison_pending`/`poison_transferred` records.
- Customer Convex Component: synced configuration, integration token, local holdovers, pending
  Exposure outbox payloads, terminal delivery metadata, and component deletion checkpoints.
- Cloudflare Queues: all four primary ingest queues and all four DLQs, including manual replay
  inventory and bounded retention evidence.
- Tinybird: raw events, Metric Events, Web Events, the deduped Exposure snapshot,
  Activation/Metric/Web aggregate states, rollups, result inputs, and audit reads.
- Sentry/Axiom/Cloudflare logs: no raw Entity data by design; request deletion from processor if a
  scrubber regression captured personal data.
- Stripe, when enabled: customer/subscription/invoice lifecycle by billing policy.

Backups are deleted by expiry. If a backup restore happens, privacy tombstones are replayed before the
restored environment can serve traffic or analytics.

## Redaction rules

Evaluation Context attributes are never logged outside the Evaluation Worker. If a worker needs to
explain a rule match, it may log field names and operators, not values. Test-evaluation may return a
human-readable reason to an authorized control-plane caller, but it must not persist the raw context.

Sentry and Axiom scrubbers apply in every Worker, CLI, MCP, SDK test harness, and frontend boundary.
Frontend-only scrubbing is insufficient.

## Verification contract

Privacy tests are required before any production implementation of evaluate, ingest, logging, export,
or deletion can ship.

Minimum required coverage:

- Redaction unit tests for nested Evaluation Context values, common PII names, breadcrumbs, exception
  messages, arrays, and stringified JSON.
- Cross-surface tests proving every Worker, CLI, MCP, SDK test harness, and frontend boundary calls the
  shared scrubber before Sentry/Axiom/log emission.
- Schema tests proving durable stores use `targeting_key_hash`, never raw Targeting Key.
- Golden leak tests with canary emails, phone-like strings, Targeting Keys, and custom attributes.
- Deletion tests proving `entity_deletions` excludes analysis before physical purge finishes.
- Queue lifecycle tests proving App and Entity suppression prevents pending outbox, primary queue,
  poison-transfer, and manual DLQ replay from re-appending deleted rows.
- Retry suppression tests proving a deleted Metric or Web Event cannot be resurrected after its
  payload-bearing claim is redacted.
- Destructive identity-reset tests proving traffic and reads remain blocked until every raw and
  derived store is purged, old `entity_deletions` are gone, Entity `privacy_requests.subject_ref`
  values are irreversibly redacted, the old key is destroyed only after every checkpoint is complete,
  and the new identity epoch cannot expose rows made unreachable by key destruction.
- Export tests proving raw API Key values, processor secrets, and other tenants' data are absent.
- Backup/restore tests proving privacy tombstones replay before serving traffic or analytics.

## Activation retention

Activation rows in `raw_events` and `deduped_activations_state` have matching default 90-day
retention. Raw `server_received_at` equals `activation_ts`; the state TTL uses the exact
`activation_ts`, so a derived Activation cannot outlive its raw fact. App and Entity deletion operate
on both layers explicitly.

## Metric Event retention

The raw `metric_events` datasource and `deduped_metric_events_state` have matching default 90-day
retention, aligned with the Exposure replay window. Every configured Conversion Window and promised
analysis replay window must fit inside both. Event Definition and Metric metadata may outlive physical
Metric Event rows and states, but immutable version records remain while any retained row references
them. Both TTL expressions use the same full `server_received_at` timestamp, so state cannot expire
earlier because of date truncation.

## Web Event retention

The raw `web_events` datasource and `deduped_web_events_state` have matching independent default
30-day retention because they contain higher-volume exploratory browser facts and are not Experiment
inputs. Retention may be configured within plan limits and has no Conversion Window or Experiment
replay minimum. Entity and App deletion obligations apply regardless of the configured TTL.
Raw and state TTL use the same full `server_received_at` timestamp.

Event Definition metadata may outlive physical Web Event rows and states, but each immutable Event
Definition Version remains available while any retained row references it.

The governing ADR is
[0032](../../adr/0032-privacy-data-lifecycle-is-an-enforced-product-contract.md).

## Product stance

Splitch does not sell or share customer Entity data and does not use sensitive personal information to
infer characteristics outside the service the customer requested. If that changes, the product must add
a California privacy choices surface before launch.

## Sources

- [ADR-0032](../../adr/0032-privacy-data-lifecycle-is-an-enforced-product-contract.md)
- [California DOJ CCPA overview](https://oag.ca.gov/privacy/ccpa)
- [California Privacy Protection Agency FAQ](https://cppa.ca.gov/faq.html)
- [CCPA regulations effective 2026-01-01](https://cppa.ca.gov/regulations/pdf/ccpa_statute_eff_20260101.pdf)
