# Privacy data lifecycle is an enforced product contract

**Status:** accepted

Privacy is not a policy-page concern bolted onto the product after data has already spread across
stores. Splitch handles customer Entity data through Evaluation Context, Targeting Key, Exposures,
Activations, Assignment Store holdovers, and Metric inputs. Those can contain personal information.
If raw Entity identifiers or Evaluation Context attributes leak into Tinybird, KV keys, Durable Object
names, audit details, Sentry, Axiom, or exported logs, deletion and access requests become unreliable.

This ADR makes privacy lifecycle behavior an architecture contract across the data plane, control
plane, SDK, CLI, MCP, observability, and analytics.

## Decision

Every privacy-facing implementation must preserve seven guarantees:

1. **Raw Entity identifiers are not durable state.** Public APIs accept the **Targeting Key**, but
   durable Entity stores use versioned `targeting_key_hash`, derived from an App-scoped secret salt.
2. **Evaluation Context values do not leave the request path.** Rule matching may use the values in
   memory. Logs, traces, audit details, errors, and durable rows may include field names and operators,
   never raw values.
3. **Deletion stops use before purge completes.** Entity deletion commits an `entity_deletions`
   tombstone first. Analysis excludes matching rows immediately while KV, Durable Object, Tinybird,
   and snapshot purge jobs finish asynchronously.
4. **User profile PII stays in WorkOS.** D1 stores WorkOS user IDs, memberships, credential metadata,
   privacy request state, and tombstoneable actor references. D1 does not duplicate email/profile PII.
5. **Audit/security records are retained with tombstones.** User or App deletion does not erase the
   fact that a control-plane mutation happened. Read surfaces replace deleted actors with a tombstone.
6. **Scrubbing applies to every emitting surface.** Frontend-only Sentry/Axiom scrubbing is
   insufficient. Workers, CLI, MCP, SDK test harnesses, background jobs, and frontend boundaries all
   use the same redaction rules.
7. **No sale/share posture is structural.** Splitch does not sell or share customer Entity data. If
   that changes, a California privacy choices surface is required before launch.

## Enforcement model

The contract is enforced in five layers:

1. **Schema and storage design.**
   - Tinybird rows, KV keys, Durable Object names, Assignment Store records, and dedup identities use
     `targeting_key_hash`, not raw Targeting Key.
   - D1 has `privacy_requests` and `entity_deletions` tables for workflow state and analysis
     exclusion.
   - Storage schemas do not include a D1 user profile table.

2. **Shared redaction primitives.**
   - One scrubber handles Targeting Key, Evaluation Context, common PII field names, nested objects,
     breadcrumbs, exception messages, and stringified payloads.
   - Surface wrappers call the scrubber before sending to Sentry, Axiom, Cloudflare logs, or CLI/MCP
     diagnostic output.

3. **Privacy jobs.**
   - Export and delete requests are asynchronous jobs with per-store status.
   - Delete jobs commit tombstones before physical purge.
   - Backup restore must replay privacy tombstones before serving traffic or analytics.

4. **Review policy.**
   Any change touching evaluate, test-evaluation, ingest, Assignment Store, Tinybird schemas, logging,
   audit details, exports, deletion, or WorkOS/D1 identity state must cite this ADR or
   [privacy-data-lifecycle.md](../spec/platform/privacy-data-lifecycle.md) and include a privacy test
   update or an explicit reason no fixture is needed.

5. **Spec lint.**
   A spec/code lint blocks reintroducing durable raw Entity fields such as `targeting_key` in storage
   schemas, Tinybird rows, KV key names, DO names, and logging payloads. Request shapes may still use
   `targetingKey` because it is the public API input.

## Required test families

Implementation must include:

- Scrubber unit tests with nested Evaluation Context, common PII names, arrays, breadcrumbs, thrown
  errors, and stringified JSON.
- Cross-surface tests proving every Worker, CLI, MCP, SDK test harness, and frontend Sentry/Axiom path
  calls the scrubber before emission.
- Schema tests proving durable Entity rows and keys use `targeting_key_hash` and reject raw
  `targeting_key` storage fields.
- Golden leak tests with canary emails, phone-like strings, user IDs, workspace IDs, and custom
  attributes. No canary may appear in captured logs, traces, audit details, exports, or test
  snapshots unless the test explicitly models a user-facing export.
- Entity deletion tests proving `entity_deletions` tombstones exclude analysis immediately before
  physical purge finishes.
- Export tests proving raw API Key values, processor-internal secrets, and other tenants' data are
  absent.
- Backup/restore tests proving privacy tombstones replay before the restored environment can serve
  reads.
- Spec-lint tests for banned storage/logging field names and for missing privacy-source links on
  privacy-sensitive specs.

Fast deterministic privacy tests run in normal PR gates. Fuzzier scrubber cases and backup/restore
simulations may run in scheduled CI, but failures are release-blocking for privacy-sensitive changes.

## Done

The privacy contract is considered enforced when:

- All durable Entity stores and analysis queries use `targeting_key_hash`.
- Shared redaction primitives are used by every Sentry/Axiom/logging surface.
- `privacy_requests` and `entity_deletions` are implemented with per-store job status.
- CI includes the required fast privacy tests and scheduled deeper privacy tests.
- Review templates call out this ADR for privacy-sensitive changes.

## Consequences

This adds explicit test and schema pressure to every data-plane and observability change. That is
intentional. Privacy bugs are not cleanup chores; they can make deletion/export promises false.

The tradeoff is that debugging payloads are less convenient. Engineers may log field names, rule ids,
operators, hashes, counts, and request ids. They may not log raw Targeting Keys or Evaluation Context
values to make debugging easier.

## Sources

- [Privacy data lifecycle spec](../spec/platform/privacy-data-lifecycle.md)
- [Sentry and Axiom PII scrubbing rules](../spec/frontend/observability-pii-scrubbing.md)
- [D1 privacy request tables](../spec/contracts/storage-schemas-d1-privacy.md)
- [Tinybird storage schemas](../spec/contracts/storage-schemas-tinybird.md)
- [California DOJ CCPA overview](https://oag.ca.gov/privacy/ccpa)
- [California Privacy Protection Agency FAQ](https://cppa.ca.gov/faq.html)
