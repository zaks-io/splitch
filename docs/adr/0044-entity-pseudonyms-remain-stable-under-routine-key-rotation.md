# Entity pseudonyms remain stable under routine key rotation

**Status:** accepted

Splitch joins Exposures, Assignment Store rows, Metric Events, and optional Entity-identified Web
Events through `targeting_key_hash`. A version-prefixed hash that changes whenever a privacy salt
rotates breaks that join for the same Targeting Key. It also changes Metric Event idempotency
fingerprints, so an exact retry after rotation can fail as conflicting content.

## Decision

Each App identity epoch owns one random secret `app_entity_identity_key`. Every durable Entity
pseudonym in that epoch uses:

```text
targeting_key_hash = HMAC_SHA256(app_entity_identity_key, id_type + ":" + targetingKey)
```

The key is immutable for the identity epoch and stored encrypted outside Tinybird. Routine
cryptographic rotation rotates or rewraps the key-encryption key without changing the underlying
identity key, identity epoch, or any derived pseudonym.

Web Session pseudonyms use the same stable identity key with a separate
`web-session:{environment_id}` domain. They cannot collide with Entity pseudonyms or another
Environment's Web Sessions.

Replacing a compromised App identity key is not routine rotation. It is an explicit destructive,
App-wide privacy reset:

1. block Evaluation, event ingest, analytics reads, exports, and new privacy requests for the App;
2. End active Runs and revoke App SDK credentials;
3. suppress and purge every App delivery from ingest outboxes, primary queues, both poison states,
   and DLQs;
4. purge all App Assignment Store state, ingest idempotency claims, raw events, Metric Events, Web
   Events, deduped snapshots and aggregate states, rollups, and result inputs;
5. purge the App's old-epoch `entity_deletions` rows and irreversibly rewrite Entity
   `privacy_requests.subject_ref` hash arrays to the non-identifying
   `redacted:app-identity-reset` audit sentinel;
6. verify every store-specific purge and ledger-redaction checkpoint before destroying the old
   identity key; and
7. create a new key and identity epoch, then require explicit credential re-issuance before traffic
   resumes.

The reset purges all App telemetry, including anonymous Web Events, because every Web Event carries a
Web Session pseudonym derived from the same key. It never leaves retained old-epoch rows that a later
Entity export or deletion could no longer locate. Splitch cannot rekey rows because it deliberately
does not store raw Targeting Keys. The privacy request keeps request type, status, timestamps,
requester, and per-store completion evidence for audit, but no old pseudonym.

## Considered options

- **Version-prefix each hash and lazily use the latest salt:** rejected because one Entity stops
  joining its retained Exposure and Metric/Web Event history, and exact retries change fingerprints.
- **Persist raw Targeting Keys or a reversible alias map for rekeying:** rejected because it creates
  the durable personal-data store this privacy boundary exists to avoid.
- **Write every active hash version on each row:** rejected because it multiplies high-cardinality
  storage and makes every Assignment, deletion, and analysis join version-aware.
- **Keep one stable App identity key and rotate its encryption wrapper:** accepted because it
  preserves pseudonymous joins while allowing routine secret-management rotation.

## Implementation boundary

The current `@splitch/privacy` implementation still uses a versioned salt and version-prefixed hash.
Metric Event and Entity-identified Web Event implementation is blocked on replacing that behavior and
migrating the existing Assignment/Exposure identity path. Specs describe the target contract, not
proof that this migration is complete.

## Consequences

Routine rotation no longer changes Entity or Web Session pseudonyms. A true identity-key compromise
requires a visible destructive reset that deletes the old epoch before the replacement key can
serve traffic. Export and deletion compute the one stable App-scoped pseudonym for the active epoch;
privacy requests submitted before reset are completed by the mandatory App-wide purge.

## Sources

- [Privacy data lifecycle spec](../spec/platform/privacy-data-lifecycle.md)
- [Metric Event contract](../spec/pipeline/metric-event-contract.md)
- [Web Event identity contract](../spec/pipeline/web-event-identity.md)
