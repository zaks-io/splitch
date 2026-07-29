-- Persisted Organization URL handle (SPL-171).
--
-- SQLite cannot ADD a NOT NULL column without a default, and a constant default
-- would collide the moment a second row exists. So: add it nullable, backfill,
-- then REBUILD the table to enforce NOT NULL.
--
-- The rebuild is not optional. A unique index does not constrain NULLs — SQLite
-- treats every NULL as distinct — so leaving the column nullable would mean
-- unlimited slugless Organizations sailing past `organizations_slug_unique`, and
-- production would run a weaker schema than the Drizzle model and every test
-- fixture declare. The response envelope requires a slug, so such a row would
-- fail validation on read: unreachable data, created silently.
--
-- The backfill seeds `slug = id` rather than slugifying `name`. `id` is unique by
-- construction, and pre-launch every Organization is a provisional one named
-- "Provisional workspace" (auth-api/src/register.ts) — slugifying that in SQL
-- would produce one collision per row for no benefit. Slug derivation from a name
-- belongs in the create path, where it can be validated and retried, not in DDL.
--
-- `apps`, `org_memberships`, and `privacy_requests` all point at `organizations`,
-- so `DROP TABLE` fails outright once a single child row exists. Deferring the
-- check lets the drop and rename land as one unit. The explicit OFF before the
-- final statement is what makes this safe: deferred constraints are verified at
-- COMMIT, and turning enforcement back on inside the transaction forces that
-- verification while the renamed table is in scope, so a genuinely orphaned row
-- still aborts the migration instead of committing a corrupt graph.
PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
ALTER TABLE `organizations` ADD `slug` text;
--> statement-breakpoint
UPDATE `organizations` SET `slug` = `id` WHERE `slug` IS NULL;
--> statement-breakpoint
CREATE TABLE `organizations_next` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`sso_enabled` integer DEFAULT false NOT NULL,
	`is_provisional` integer DEFAULT false NOT NULL,
	`demo_expires_at` text,
	`claim_acquired_at` text,
	`claim_acquisition_token` text,
	`claim_acquisition_key_hash` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `organizations_next` (
	`id`, `name`, `slug`, `plan`, `stripe_customer_id`, `stripe_subscription_id`,
	`sso_enabled`, `is_provisional`, `demo_expires_at`, `claim_acquired_at`,
	`claim_acquisition_token`, `claim_acquisition_key_hash`, `created_at`, `updated_at`
)
SELECT
	`id`, `name`, `slug`, `plan`, `stripe_customer_id`, `stripe_subscription_id`,
	`sso_enabled`, `is_provisional`, `demo_expires_at`, `claim_acquired_at`,
	`claim_acquisition_token`, `claim_acquisition_key_hash`, `created_at`, `updated_at`
FROM `organizations`;
--> statement-breakpoint
DROP TABLE `organizations`;
--> statement-breakpoint
ALTER TABLE `organizations_next` RENAME TO `organizations`;
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);
--> statement-breakpoint
PRAGMA defer_foreign_keys = OFF;
