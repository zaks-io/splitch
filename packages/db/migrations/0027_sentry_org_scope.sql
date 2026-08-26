-- Move Sentry change-tracking installations from Environment scope to
-- Organization scope.
--
-- Sentry stores ONE signing secret per provider type per organization, and its
-- flag log has no project or environment axis (getsentry/sentry
-- `src/sentry/flags/docs/api.md`). Under the Environment scoping shipped in
-- 0026, a second Environment wired to the same Sentry org minted a second secret
-- that silently invalidated the first: the older installation kept POSTing and
-- Sentry kept answering 401.
--
-- SQLite cannot drop an indexed column, so the table is rebuilt. Existing rows
-- carry over with their cursor and their sealed secret intact, mapped to the
-- Organization that owns the App they were installed under. Where an
-- Organization had more than one ACTIVE installation, only the most recently
-- created survives as active: Sentry was already honouring only that one's
-- secret, so revoking the others records what was true rather than changing it.

CREATE TABLE `sentry_installations_org_scoped` (
  `installation_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL REFERENCES `organizations`(`id`),
  `webhook_url` text NOT NULL,
  `secret_ciphertext` text NOT NULL,
  `secret_key_version` text NOT NULL,
  `secret_fingerprint` text NOT NULL,
  `last_rotation_id` text,
  `last_rotation_fingerprint` text,
  `status` text NOT NULL CHECK (`status` IN ('active', 'revoked')),
  `last_delivered_seq` integer,
  `last_delivered_at` text,
  `attempt_count` integer NOT NULL DEFAULT 0,
  `next_attempt_at` text NOT NULL,
  `latest_delivery_error_json` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `revoked_at` text
);
--> statement-breakpoint

INSERT INTO `sentry_installations_org_scoped` (
  `installation_id`, `org_id`, `webhook_url`, `secret_ciphertext`, `secret_key_version`,
  `secret_fingerprint`, `last_rotation_id`, `last_rotation_fingerprint`, `status`,
  `last_delivered_seq`, `last_delivered_at`, `attempt_count`, `next_attempt_at`,
  `latest_delivery_error_json`, `created_at`, `updated_at`, `revoked_at`
)
SELECT
  `s`.`installation_id`, `a`.`organization_id`, `s`.`webhook_url`, `s`.`secret_ciphertext`,
  `s`.`secret_key_version`, `s`.`secret_fingerprint`, `s`.`last_rotation_id`,
  `s`.`last_rotation_fingerprint`, `s`.`status`, `s`.`last_delivered_seq`,
  `s`.`last_delivered_at`, `s`.`attempt_count`, `s`.`next_attempt_at`,
  `s`.`latest_delivery_error_json`, `s`.`created_at`, `s`.`updated_at`, `s`.`revoked_at`
FROM `sentry_installations` AS `s`
JOIN `apps` AS `a` ON `a`.`id` = `s`.`app_id`;
--> statement-breakpoint

-- Collapse the Environment fan-out: keep the newest active row per Organization.
-- `created_at` alone cannot decide it. Two Environments wired in the same second
-- share a timestamp, and a tie that keeps both rows active would fail the
-- one-active-per-Organization index below after the old table is already gone,
-- so `installation_id` breaks it.
UPDATE `sentry_installations_org_scoped`
SET `status` = 'revoked',
  `revoked_at` = COALESCE(`revoked_at`, `updated_at`)
WHERE `status` = 'active'
  AND `installation_id` NOT IN (
    SELECT `installation_id` FROM `sentry_installations_org_scoped` AS `keep`
    WHERE `keep`.`status` = 'active'
      AND `keep`.`installation_id` = (
        SELECT `newest`.`installation_id`
        FROM `sentry_installations_org_scoped` AS `newest`
        WHERE `newest`.`org_id` = `keep`.`org_id` AND `newest`.`status` = 'active'
        ORDER BY `newest`.`created_at` DESC, `newest`.`installation_id` DESC
        LIMIT 1
      )
  );
--> statement-breakpoint

DROP TABLE `sentry_installations`;
--> statement-breakpoint

ALTER TABLE `sentry_installations_org_scoped` RENAME TO `sentry_installations`;
--> statement-breakpoint

CREATE INDEX `sentry_installations_due_idx` ON `sentry_installations` (`status`, `next_attempt_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `sentry_installations_scope_id_unique` ON `sentry_installations` (`org_id`, `installation_id`);
--> statement-breakpoint
-- One Sentry organization per splitch Organization: Sentry holds a single
-- signing secret per provider, so a second active installation would replace the
-- secret the first one still signs with.
CREATE UNIQUE INDEX `sentry_installations_active_scope_unique` ON `sentry_installations` (`org_id`) WHERE `status` = 'active';
