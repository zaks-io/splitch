CREATE TABLE `cloudflare_installations` (
  `installation_id` text PRIMARY KEY NOT NULL,
  `app_id` text NOT NULL REFERENCES `apps`(`id`),
  `environment_id` text NOT NULL REFERENCES `environments`(`id`),
  `endpoint` text NOT NULL,
  `secret_ciphertext` text NOT NULL,
  `secret_key_version` text NOT NULL,
  `secret_fingerprint` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('active', 'revoked')),
  `last_applied_version` integer,
  `last_applied_at` text,
  `latest_delivery_error_json` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `revoked_at` text
);
--> statement-breakpoint
CREATE INDEX `cloudflare_installations_scope_status_idx`
  ON `cloudflare_installations` (`app_id`, `environment_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `cloudflare_installations_scope_id_unique`
  ON `cloudflare_installations` (`app_id`, `environment_id`, `installation_id`);
--> statement-breakpoint

CREATE TABLE `cloudflare_config_deliveries` (
  `delivery_id` text PRIMARY KEY NOT NULL,
  `installation_id` text NOT NULL REFERENCES `cloudflare_installations`(`installation_id`),
  `app_id` text NOT NULL REFERENCES `apps`(`id`),
  `environment_id` text NOT NULL REFERENCES `environments`(`id`),
  `environment_version` integer NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('pending', 'leased', 'delivered', 'terminal', 'suppressed')),
  `attempt_count` integer NOT NULL DEFAULT 0,
  `next_attempt_at` text NOT NULL,
  `lease_owner` text,
  `lease_expires_at` text,
  `last_error_json` text,
  `created_at` text NOT NULL,
  `delivered_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cloudflare_config_delivery_installation_version_unique`
  ON `cloudflare_config_deliveries` (`installation_id`, `environment_version`);
--> statement-breakpoint
CREATE INDEX `cloudflare_config_delivery_lease_idx`
  ON `cloudflare_config_deliveries` (`state`, `next_attempt_at`, `lease_expires_at`);
--> statement-breakpoint

CREATE TRIGGER `cloudflare_environment_version_delivery_after_update`
AFTER UPDATE OF `config_version` ON `environments`
WHEN NEW.`config_version` > OLD.`config_version`
BEGIN
  UPDATE `cloudflare_config_deliveries`
  SET `state` = 'suppressed'
  WHERE `app_id` = NEW.`app_id`
    AND `environment_id` = NEW.`id`
    AND `state` = 'pending';

  INSERT OR IGNORE INTO `cloudflare_config_deliveries` (
    `delivery_id`, `installation_id`, `app_id`, `environment_id`, `environment_version`,
    `state`, `attempt_count`, `next_attempt_at`, `created_at`
  )
  SELECT
    substr(replace(installation.`installation_id`, '-', ''), 1, 8) || '-' ||
    substr(replace(installation.`installation_id`, '-', ''), 9, 4) || '-' ||
    substr(replace(installation.`installation_id`, '-', ''), 13, 4) || '-' ||
    substr(replace(installation.`installation_id`, '-', ''), 17, 4) || '-' ||
    substr(replace(installation.`installation_id`, '-', ''), 21, 4) || printf('%08x', NEW.`config_version`),
    installation.`installation_id`, NEW.`app_id`, NEW.`id`, NEW.`config_version`,
    'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM `cloudflare_installations` installation
  WHERE installation.`app_id` = NEW.`app_id`
    AND installation.`environment_id` = NEW.`id`
    AND installation.`status` = 'active';
END;
