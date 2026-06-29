import { text } from "drizzle-orm/sqlite-core";

/**
 * Shared column builders. D1 is SQLite: there is no native `timestamptz` or
 * `boolean`, so the storage-spec `timestamptz` columns are ISO 8601 TEXT (the
 * same shape the Zod contract leaves carry as `z.string()`), and the spec's
 * `boolean`/INTEGER 0|1 columns are `integer({ mode: "boolean" })` at the call
 * site. Centralising the timestamp builders keeps the audit columns identical
 * across every table (DRY) instead of re-declaring `text(...).notNull()` 19×.
 */

/** ISO 8601 creation timestamp; every table carries one. */
export const createdAt = () => text("created_at").notNull();

/** ISO 8601 last-write timestamp; mutable tables carry one. */
export const updatedAt = () => text("updated_at").notNull();

/**
 * WorkOS user ID or a deleted-user tombstone string. D1 never stores user PII;
 * audit columns hold only the opaque reference (storage-schemas-d1.md).
 */
export const userRef = (name: string) => text(name);
