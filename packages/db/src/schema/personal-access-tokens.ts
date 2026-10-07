import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, userRef } from "./columns";

/**
 * Personal Access Tokens (ADR-0022, 2026-10-03 amendment): user-bound, MCP-only
 * bearer credentials. Keyed by the owning WorkOS user, not by a tenant: a PAT's
 * reach is that user's live membership clamped by `grants`, resolved at request
 * time, so no Organization or App is stored on the row.
 *
 * Only the SHA-256 hash of the secret is stored; the raw value is surfaced once.
 */
export const personalAccessTokens = sqliteTable(
  "personal_access_tokens",
  {
    id: text("id").primaryKey(),
    userId: userRef("user_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    // JSON array of PersonalAccessTokenGrant.
    grants: text("grants").notNull(),
    // ISO 8601; null = never expires (an explicit choice at create/update).
    expiresAt: text("expires_at"),
    lastRotatedAt: text("last_rotated_at"),
    revokedAt: text("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("personal_access_tokens_token_hash_unique").on(t.tokenHash),
    index("personal_access_tokens_user_idx").on(t.userId),
  ],
);
