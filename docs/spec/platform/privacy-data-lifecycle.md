# Privacy data lifecycle: export, deletion, retention, and redaction

This is the cross-cutting contract for privacy requests. It defines what data exists, who controls it,
how Splitch exports or deletes it, and what is retained for legal or security reasons.

This is a product baseline for compliance work, not legal advice. As of 2026-06-21, California's CCPA
baseline includes rights to know/access, delete, correct, opt out of sale/sharing, limit sensitive
personal information use, notice, and non-discrimination. Delete/correct/know requests must be
acknowledged within 10 business days and answered within 45 calendar days, with one 45-day extension
after notice. Opt-out and limit requests must be honored as soon as feasible, no later than 15 business
days.

## Privacy roles

| Data class              | Examples                                                                                 | Role                                                       | Durable stores                             |
| ----------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| Control-plane User data | WorkOS user ID, email in WorkOS, memberships, sessions, device-flow tokens               | Splitch-controlled                                         | WorkOS, D1 IDs, KV sessions, keychain/CLI  |
| Organization/App config | Orgs, Apps, Environments, Flags, Experiments, Metrics, Segments, credential metadata     | Customer-controlled                                        | D1, KV config cache, per-App DO            |
| Entity data             | Targeting Key, idType, Exposures, Activations, Metric Events, Assignment Store holdovers | Customer-controlled; Splitch is processor/service provider | Tinybird, KV, Assignment Store DO          |
| Audit/security data     | control-plane mutation audit, auth door, actor ID, request logs                          | shared legal/security record                               | Tinybird audit log, D1 privacy request log |
| Observability data      | errors, traces, structured logs                                                          | Splitch-controlled operations data                         | Sentry, Axiom, Cloudflare logs             |
| Billing data            | plan, Stripe customer/subscription IDs, invoices                                         | Splitch-controlled billing data                            | D1, Stripe when enabled                    |

## Entity privacy identity

The public API still accepts the **Targeting Key**. Durable Entity stores MUST use a derived
`targeting_key_hash`, not the raw value:

```
targeting_key_hash = key_version + ":" + HMAC_SHA256(app_privacy_salt[key_version], id_type + ":" + targetingKey)
```

Rules:

- `app_privacy_salt` is secret, App-scoped, versioned, and stored outside Tinybird.
- New Entity rows use the latest salt version. Historical rows keep their original hash version.
- Entity export/delete computes one `targeting_key_hash` per active salt version and operates on all
  matches. Old salt versions are kept until every row using that version has expired or been purged.
- The raw Targeting Key is used in memory for `assign()`, Condition matching, or Metric Event HMAC
  derivation, then discarded.
- KV keys, DO names, Tinybird rows, Axiom fields, Sentry payloads, and audit details never contain the
  raw Targeting Key or raw Evaluation Context attributes.
- Data subject requests take `{ app_id, id_type, targetingKey }`; the Control Plane API Worker computes
  `targeting_key_hash` server-side.

## Privacy request ledger

D1 owns a bounded `privacy_requests` table:

| column            | meaning                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `request_id`      | ULID                                                                                       |
| `org_id`          | Organization receiving the request                                                         |
| `app_id`          | nullable; present for App/Entity requests                                                  |
| `request_type`    | `access` \| `export` \| `correct` \| `delete` \| `opt_out_sale_share` \| `limit_sensitive` |
| `subject_type`    | `user` \| `organization` \| `app` \| `entity`                                              |
| `subject_ref`     | WorkOS user ID, org/app ID, or JSON array of `targeting_key_hash` values                   |
| `requested_by`    | WorkOS user ID of the requester                                                            |
| `status`          | `received` \| `verifying` \| `processing` \| `completed` \| `denied`                       |
| `received_at`     | server timestamp                                                                           |
| `ack_due_at`      | received_at + 10 business days                                                             |
| `response_due_at` | received_at + 45 calendar days, extendable once                                            |
| `completed_at`    | nullable                                                                                   |
| `denial_reason`   | nullable; policy/legal reason only                                                         |

The ledger stores hashes and IDs, not email, raw Targeting Keys, or raw Evaluation Context attributes.
Keep it for at least 24 months or the contractually configured audit period, whichever is longer.

## Export contracts

Exports are asynchronous jobs with a signed, expiring download URL. Raw secrets are never exported.

| Export              | Included                                                                                                            | Excluded                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| User export         | WorkOS profile, org/app memberships, sessions, issued tokens metadata, audit entries where actor                    | API Key raw values, other users' data          |
| Organization export | Org, Apps, Environments, config, credential metadata, members, audit log, billing metadata                          | raw API Key values, processor-internal secrets |
| App export          | Flag/Experiment/Event Definition/Metric/Segment config, Runs, results, credential metadata, audit rows              | other Apps in the Org                          |
| Entity export       | rows matching `targeting_key_hash` in Assignment Store, raw events, Metric Events, deduped snapshots, result inputs | raw Targeting Rules for non-admin requesters   |

Entity exports are scoped by App and idType. They include the categories, sources, purposes, and
processors for the data, not only the physical rows.

## Deletion contracts

Deletion is a two-phase job: stop future use first, then hard-purge every store that can hold the data.

| Deletion                | Immediate action                                                    | Purge action                                                                                            |
| ----------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| User                    | revoke sessions, refresh tokens, CLI/MCP tokens; remove memberships | delete or disable WorkOS user; remove D1 memberships; replace actor display with deleted-user tombstone |
| Personal Organization   | revoke all SDK credentials and stop ingest/evaluate                 | purge all Apps, config, KV, DO state, Tinybird data, WorkOS org                                         |
| Enterprise Organization | require owner approval and SSO/billing checks                       | same as personal Org after approval; preserve contracted audit records                                  |
| App                     | revoke App credentials; block SDK evaluate/ingest                   | purge D1/KV config, Assignment Store, event rows, snapshots, rollups, audit read visibility             |
| Entity                  | insert `entity_deletions` tombstone and exclude from analysis       | delete Assignment Store key/DO row and Tinybird rows matching `targeting_key_hash`                      |

`entity_deletions` contains `{ app_id, id_type, targeting_key_hash, delete_before_ts, requested_at,
completed_at }`. The Analysis Worker MUST exclude rows where `server_ts <= delete_before_ts` as soon as
the tombstone is committed, even before Tinybird hard purge finishes. New events for the same Targeting
Key after `delete_before_ts` are treated as newly collected customer data.

Audit/security rows are not used for product analytics or targeting. If retained under legal/security
exceptions, read surfaces show a deleted-user tombstone instead of a name or email.

## Store checklist

Every delete job must record per-store status for:

- WorkOS: user, Organization, SSO/SCIM state.
- D1: Organization/App/config/membership/credential metadata/privacy ledgers.
- KV: sessions, credential caches, config cache, liveRun keys, Assignment Store read keys.
- Durable Objects: per-App live-update state and Assignment Store writer rows.
- Tinybird: raw events, Metric Events, deduped exposures, rollups, audit reads.
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
- Export tests proving raw API Key values, processor secrets, and other tenants' data are absent.
- Backup/restore tests proving privacy tombstones replay before serving traffic or analytics.

## Metric Event retention

The `metric_events` datasource has a default 90-day retention, matching the Exposure replay window.
Every configured Conversion Window and promised analysis replay window must fit inside retention.
Event Definition and Metric metadata may outlive physical Metric Event rows, but immutable version
records remain while any retained row references them.

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
