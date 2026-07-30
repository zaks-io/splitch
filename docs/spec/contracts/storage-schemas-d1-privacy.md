# Storage schemas: D1 privacy request tables

D1 column shapes for privacy request lifecycle state. These tables are bounded workflow records,
not the source of raw customer Entity data.

Storage shapes carry internals that wire shapes must not expose. The product lifecycle is defined in
[../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md).

---

## `privacy_requests`

Bounded request ledger. Stores hashes and IDs, not raw Targeting Keys or email.

| Column            | Type        | Constraints                                        |
| ----------------- | ----------- | -------------------------------------------------- |
| `request_id`      | text        | PK                                                 |
| `org_id`          | text        | FK to organizations, not null                      |
| `app_id`          | text        | nullable, FK to apps                               |
| `request_type`    | text        | not null                                           |
| `subject_type`    | text        | not null                                           |
| `subject_ref`     | text        | not null; ID string or JSON array of Entity hashes |
| `requested_by`    | text        | WorkOS user ID, not null                           |
| `status`          | text        | not null                                           |
| `received_at`     | timestamptz | not null                                           |
| `ack_due_at`      | timestamptz | not null                                           |
| `response_due_at` | timestamptz | not null                                           |
| `completed_at`    | timestamptz | nullable                                           |
| `denial_reason`   | text        | nullable                                           |

`subject_ref` is a WorkOS user ID, Org/App ID, or JSON array of `targeting_key_hash` values.

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

## Sources

- [../../adr/0032-privacy-data-lifecycle-is-an-enforced-product-contract.md](../../adr/0032-privacy-data-lifecycle-is-an-enforced-product-contract.md)
- [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
