# Entity pseudonyms remain stable under routine key rotation

**Status:** accepted

Splitch joins Exposures, Assignment Store rows, Metric Events, and optional Entity-identified Web
Events through `targeting_key_hash`. A version-prefixed hash that changes whenever a privacy salt
rotates breaks that join for the same Targeting Key. It also changes Metric Event idempotency
fingerprints, so an exact retry after rotation can fail as conflicting content.

## Decision

Each App owns one random secret `app_entity_identity_key`. Every durable Entity pseudonym uses:

```text
targeting_key_hash = HMAC_SHA256(app_entity_identity_key, id_type + ":" + targetingKey)
```

The key is immutable for the App lifetime and stored encrypted outside Tinybird. Routine
cryptographic rotation rotates or rewraps the key-encryption key without changing the underlying App
identity key or any derived pseudonym.

Web Session pseudonyms use the same stable identity key with a separate
`web-session:{environment_id}` domain. They cannot collide with Entity pseudonyms or another
Environment's Web Sessions.

Replacing a compromised App identity key is not routine rotation. It is an explicit destructive
privacy operation that Ends active Runs, clears Assignment Store state and ingest idempotency claims,
and starts a non-joining identity epoch for future data. Splitch cannot rekey retained rows because
it deliberately does not store raw Targeting Keys.

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
requires a visible destructive reset and intentionally severs future data from retained history.
Export and deletion compute one stable App-scoped pseudonym rather than probing multiple salt
versions.

## Sources

- [Privacy data lifecycle spec](../spec/platform/privacy-data-lifecycle.md)
- [Metric Event contract](../spec/pipeline/metric-event-contract.md)
- [Web Event identity contract](../spec/pipeline/web-event-identity.md)
