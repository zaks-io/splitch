# The flag change log is both the audit record and the integration outbox

**Status:** accepted

Splitch could not answer "who changed this Flag, and when." `flags` carried only last-writer
`created_by`/`updated_by`; `flag_configs`, the table holding `enabled`, `rollout`, and the
available Variant set (where every change an operator actually makes lands), had no actor
column at all. `approval_requests` records only gated mutations. `config_webhook_deliveries`
(ADR-0049) carries an opaque `config.changed` version bump with no Flag, action, or actor.

Sentry's generic feature-flag provider hook forced the question: change tracking needs a stream of
`{action, change_id, created_at, created_by, flag}`, and there was nothing to project from.

## Decision

1. **`flag_change_events` is an append-only log of every Flag-domain mutation.** One row per change,
   carrying `app_id`, nullable `environment_id`, `flag_key`, `action`, `target_type`, `actor_ref`,
   `actor_via`, `changed_at`, and a `diff_json` recording the transition, not just the landing value.
   Vocabulary is `approval_requests`' verbatim (`target_type`, `diff`), not a synonym set.

2. **D1 triggers write it, not the repository seam.** A trigger cannot be bypassed by a route, a
   migration script, a future write path, or an agent with a D1 binding. A repo-level write is a
   convention that holds only as long as everyone remembers it, and an audit record that a write path
   can forget to emit is not an audit record.

3. **The log carries no foreign keys to what it audits.** Deleting a Flag must not abort on, or
   cascade into, the record of its deletion. The audit row is the one thing that has to outlive its
   subject.

4. **`seq INTEGER PRIMARY KEY AUTOINCREMENT` is the change id.** It is monotonic, unique, and
   64-bit, which is exactly Sentry's `change_id` idempotency-token contract. There is no second
   identifier to keep in sync.

5. **Each integration installation carries a delivery cursor; there is no outbox table.** The log is
   the outbox. `last_delivered_seq` on `sentry_installations` is the whole delivery state.
   At-least-once redelivery is safe by construction because the consumer's contract is idempotent on
   `change_id`. The cursor advances only on an accepted delivery, never past a rejection, even a
   terminal 4xx, because skipping the batch would silently drop real production changes.

6. **The Organization is the installation axis.** Sentry's flag log is organization-wide: one
   signing secret per provider type per Sentry organization, and no project or environment field
   anywhere in the generic webhook's payload. So one splitch Organization maps to one Sentry
   organization and publishes every Flag change under it, across all its Apps and Environments. The
   unique index is `(organization_id) WHERE status = 'active'`. Filtering the stream by App or
   Environment was considered and rejected: with nowhere in the payload to say which one a change
   came from, a filter would silently drop real production changes from the one log Sentry
   correlates errors against (ADR-0027, ADR-0036). The cost is that a Flag key reused across Apps or
   Environments appears in Sentry as several changes to the same name.

   This reverses the Environment-scoped axis this ADR originally decided, and migration
   `0027_sentry_org_scope.sql` rebuilds `sentry_installations` accordingly, revoking all but the
   newest active row per Organization. The original reading, that a prod Sentry organization must
   not hear about dev toggles, described a separation Sentry does not offer: two Environments wiring
   up the same Sentry organization each minted a secret, and the second silently invalidated the
   first.

7. **An unattributable change is sent as unattributed, not dropped and not fabricated.** Sentry
   requires `created_by`. Variant and Targeting Rule writes have no actor on their own row, so those
   events carry `actor_ref NULL`. Dropping them would hide a real production change; inheriting the
   owning Flag's `updated_by` would name whoever last renamed the Flag, which is a wrong answer
   wearing a right answer's clothes. They ship as `{"id": "unattributed", "type": "name"}`, and each
   batch logs the count and the affected `seq` values.

8. **splitch mints the signing secret, and the installation routes live on the operator door.**
   Sentry's Generic-provider form gives no secret; it asks the provider for one. So `webhookSecret`
   is optional on write, the server generates one when it is absent, and the response carries it
   exactly once, the same custody an API Key gets. The routes address the Organization in the path
   (`/orgs/:orgId/integrations/sentry/installations`) rather than reading it from an edge
   credential, because a Control Panel delegation claim must name the resource it acts on. That is
   what makes the Organization Integrations card possible without a second auth path.

9. **Retention is age plus every cursor.** The daily cron prunes rows older than 90 days that are
   also behind the minimum undelivered `seq` across active installations. A backlog is never deleted
   out from under an installation, however old it is.

## Considered options

- **Write the log from the repository seam** was rejected under decision 2.
- **A separate delivery outbox per integration**, mirroring `config_webhook_deliveries`, was rejected
  as strictly more machinery for no property the cursor does not already give: the consumer's
  idempotency token is the log's own primary key.
- **Group a delivery batch by `(flag_key, action)` to inherit a sibling event's actor** was rejected.
  It collapses distinct changes, and there is no reliable transaction key to group on because
  `strftime('now')` is re-read per statement.
- **Subquery the owning `flag_configs.updated_by` from the Targeting Rule triggers** was rejected.
  The ungated `replaceTargetingRules` batch updates the config row last while the approval path
  updates it first, so the subquery reads a stale actor on one of the two paths. Making the answer
  depend on statement ordering is the class of fix this repo rejects.
- **Filter unattributed events out of the Sentry projection** was rejected under decision 7.
- **Cover the org, app, membership, and credential domains now** was deferred. The write side is
  general enough to extend; the Flag domain is what has a consumer today.

## Consequences

- `flag_configs` gains `updated_by`/`updated_via`, and every write path that builds a config patch
  must stamp them. A path that forgets produces an unattributed audit row, which is visible, not
  silent.
- The read surface for the change log is deliberately absent: no history endpoint, no
  `splitch flag history`, no panel view of the log itself. Having the data is the deliverable;
  exposing it is a later slice. The Sentry installation is the exception the operator has to reach,
  so it gets a Control Panel card and nothing else does.
- `sentry_installations` reuses the AES-GCM envelope custody in `integration-secret.ts` and the
  existing `INTEGRATION_SECRET_KEK`, the same key the Cloudflare integration already uses. No new
  KEK name, so no ops step: a missing KEK still throws rather than falling back.
- The log grows with write volume across every Flag-domain table, so the retention cron is
  load-bearing rather than housekeeping.

## Sources

- [Sentry: create a generic flag log](https://docs.sentry.io/organization/integrations/feature-flag/generic/#change-tracking)
- [Sentry flags API contract](https://github.com/getsentry/sentry/blob/master/src/sentry/flags/docs/api.md)
- [SQLite CREATE TRIGGER](https://www.sqlite.org/lang_createtrigger.html)
- [SQLite AUTOINCREMENT](https://www.sqlite.org/autoinc.html)
- [ADR-0018](./0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md),
  [ADR-0027](./0027-environment-is-a-first-class-axis-under-app.md),
  [ADR-0032](./0032-privacy-data-lifecycle-is-an-enforced-product-contract.md),
  [ADR-0036](./0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md),
  [ADR-0049](./0049-convex-local-evaluation-uses-nudge-pull-sync-and-transactional-exposure-delivery.md)
