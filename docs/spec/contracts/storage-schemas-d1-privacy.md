# Storage schemas: D1 privacy request tables

D1 column shapes for privacy request lifecycle state. These tables are bounded workflow records,
not the source of raw customer Entity data.

Storage shapes carry internals that wire shapes must not expose. The product lifecycle is defined in
[../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md).

---

## `privacy_requests`

Bounded request ledger. Stores hashes and IDs, not raw Targeting Keys or email.

| Column                    | Type        | Constraints                                        |
| ------------------------- | ----------- | -------------------------------------------------- |
| `request_id`              | text        | PK                                                 |
| `org_id`                  | text        | FK to organizations, not null                      |
| `app_id`                  | text        | nullable, FK to apps                               |
| `request_type`            | text        | not null                                           |
| `subject_type`            | text        | not null                                           |
| `subject_ref`             | text        | not null; ID, Entity-hash array, or reset sentinel |
| `subject_ref_redacted_at` | timestamptz | nullable                                           |
| `requested_by`            | text        | WorkOS user ID, not null                           |
| `status`                  | text        | not null                                           |
| `received_at`             | timestamptz | not null                                           |
| `ack_due_at`              | timestamptz | not null                                           |
| `response_due_at`         | timestamptz | not null                                           |
| `completed_at`            | timestamptz | nullable                                           |
| `denial_reason`           | text        | nullable                                           |

`subject_ref` is a WorkOS user ID, Org/App ID, JSON array of `targeting_key_hash` values, or the
literal `redacted:app-identity-reset`. A destructive App identity reset must replace every matching
Entity hash array with that sentinel and stamp `subject_ref_redacted_at` before destroying the old
identity key.

## `entity_deletions`

Analysis exclusion and physical purge ledger for customer Entity deletion requests.

| Column               | Type        | Constraints          |
| -------------------- | ----------- | -------------------- |
| `app_id`             | text        | FK to apps, not null |
| `id_type`            | text        | not null             |
| `targeting_key_hash` | text        | not null             |
| `delete_before_ts`   | timestamptz | not null             |
| `requested_at`       | timestamptz | not null             |
| `completed_at`       | timestamptz | nullable             |

Composite PK: `(app_id, id_type, targeting_key_hash, delete_before_ts)`.

The Analysis Worker excludes matching rows where `server_received_at <= delete_before_ts` immediately after
the tombstone commits. Physical purge can finish asynchronously.

A destructive App identity reset purges the App's `entity_deletions` rows only after all old-epoch
outboxes, queues, DLQs, raw facts, derived facts, and result inputs are purged. New credentials and a
new identity epoch are created only after that purge checkpoint and privacy-request redaction pass.

## Sources

- [../../adr/0032-privacy-data-lifecycle-is-an-enforced-product-contract.md](../../adr/0032-privacy-data-lifecycle-is-an-enforced-product-contract.md)
- [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
