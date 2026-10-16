import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { personalAccessTokens } from "./personal-access-tokens";

export const personalAccessTokenStepUpUses = sqliteTable(
  "personal_access_token_step_up_uses",
  {
    jti: text("jti").primaryKey(),
    userId: text("user_id").notNull(),
    consumedAt: text("consumed_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("personal_access_token_step_up_uses_retention_idx").on(t.expiresAt, t.jti)],
);

export const personalAccessTokenRotations = sqliteTable(
  "personal_access_token_rotations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    tokenId: text("token_id")
      .notNull()
      .references(() => personalAccessTokens.id, { onDelete: "cascade" }),
    previousHash: text("previous_hash").notNull(),
    candidateHash: text("candidate_hash").notNull(),
    operationHash: text("operation_hash").notNull(),
    stepUpJti: text("step_up_jti").references(() => personalAccessTokenStepUpUses.jti),
    phase: text("phase", {
      enum: [
        "claimed",
        "old_tombstoned",
        "candidate_published",
        "swapped",
        "completed",
        "retiring",
        "retired",
      ],
    }).notNull(),
    claimedAt: text("claimed_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("personal_access_token_rotations_exclusive_idx")
      .on(t.tokenId)
      .where(sql`${t.phase} NOT IN ('completed', 'retired')`),
    index("personal_access_token_rotations_pending_idx").on(t.phase, t.updatedAt),
  ],
);
