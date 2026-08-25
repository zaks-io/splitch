ALTER TABLE `environments` ADD `config_version` integer NOT NULL DEFAULT 0;
--> statement-breakpoint

CREATE TABLE `convex_installations` (
  `installation_id` text PRIMARY KEY NOT NULL,
  `app_id` text NOT NULL REFERENCES `apps`(`id`),
  `environment_id` text NOT NULL REFERENCES `environments`(`id`),
  `callback_url` text NOT NULL,
  `secret_ciphertext` text NOT NULL,
  `secret_key_version` text NOT NULL,
  `secret_fingerprint` text NOT NULL,
  `last_rotation_id` text,
  `last_rotation_fingerprint` text,
  `status` text NOT NULL CHECK (`status` IN ('active', 'revoked')),
  `last_delivered_version` integer,
  `last_delivered_at` text,
  `latest_delivery_error_json` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `revoked_at` text
);
--> statement-breakpoint
CREATE INDEX `convex_installations_scope_status_idx` ON `convex_installations` (`app_id`, `environment_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `convex_installations_scope_id_unique` ON `convex_installations` (`app_id`, `environment_id`, `installation_id`);
--> statement-breakpoint

CREATE TABLE `config_webhook_deliveries` (
  `delivery_id` text PRIMARY KEY NOT NULL,
  `installation_id` text NOT NULL REFERENCES `convex_installations`(`installation_id`),
  `app_id` text NOT NULL REFERENCES `apps`(`id`),
  `environment_id` text NOT NULL REFERENCES `environments`(`id`),
  `environment_version` integer NOT NULL,
  `body_json` text NOT NULL,
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
CREATE UNIQUE INDEX `config_webhook_delivery_installation_version_unique` ON `config_webhook_deliveries` (`installation_id`, `environment_version`);
--> statement-breakpoint
CREATE INDEX `config_webhook_delivery_lease_idx` ON `config_webhook_deliveries` (`state`, `next_attempt_at`, `lease_expires_at`);
--> statement-breakpoint

CREATE TRIGGER `convex_flag_config_version_after_insert`
AFTER INSERT ON `flag_configs`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1 WHERE `id` = NEW.`environment_id` AND `app_id` = NEW.`app_id`;
END;
--> statement-breakpoint

CREATE TRIGGER `convex_flag_config_version_after_update`
AFTER UPDATE ON `flag_configs`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1 WHERE `id` = NEW.`environment_id` AND `app_id` = NEW.`app_id`;
END;
--> statement-breakpoint

CREATE TRIGGER `convex_flag_config_version_after_delete`
AFTER DELETE ON `flag_configs`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1 WHERE `id` = OLD.`environment_id` AND `app_id` = OLD.`app_id`;
END;
--> statement-breakpoint

CREATE TRIGGER `convex_targeting_rule_version_after_insert`
AFTER INSERT ON `targeting_rules`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1 WHERE `id` = NEW.`environment_id` AND `app_id` = NEW.`app_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `convex_targeting_rule_version_after_update`
AFTER UPDATE ON `targeting_rules`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1 WHERE `id` = NEW.`environment_id` AND `app_id` = NEW.`app_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `convex_targeting_rule_version_after_delete`
AFTER DELETE ON `targeting_rules`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1 WHERE `id` = OLD.`environment_id` AND `app_id` = OLD.`app_id`;
END;
--> statement-breakpoint

CREATE TRIGGER `convex_experiment_version_after_insert`
AFTER INSERT ON `experiments`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1 WHERE `id` = NEW.`environment_id` AND `app_id` = NEW.`app_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `convex_experiment_version_after_update`
AFTER UPDATE ON `experiments`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1 WHERE `id` = NEW.`environment_id` AND `app_id` = NEW.`app_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `convex_experiment_version_after_delete`
AFTER DELETE ON `experiments`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1 WHERE `id` = OLD.`environment_id` AND `app_id` = OLD.`app_id`;
END;
--> statement-breakpoint

CREATE TRIGGER `convex_run_version_after_insert`
AFTER INSERT ON `runs`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1 WHERE `id` = NEW.`environment_id` AND `app_id` = NEW.`app_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `convex_run_version_after_update`
AFTER UPDATE ON `runs`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1 WHERE `id` = NEW.`environment_id` AND `app_id` = NEW.`app_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `convex_run_version_after_delete`
AFTER DELETE ON `runs`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1 WHERE `id` = OLD.`environment_id` AND `app_id` = OLD.`app_id`;
END;
--> statement-breakpoint

CREATE TRIGGER `convex_flag_version_after_insert`
AFTER INSERT ON `flags`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1 WHERE `app_id` = NEW.`app_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `convex_flag_version_after_update`
AFTER UPDATE ON `flags`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1 WHERE `app_id` = NEW.`app_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `convex_flag_version_after_delete`
AFTER DELETE ON `flags`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1 WHERE `app_id` = OLD.`app_id`;
END;
--> statement-breakpoint

CREATE TRIGGER `convex_variant_version_after_insert`
AFTER INSERT ON `variants`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1
  WHERE `app_id` = (SELECT `app_id` FROM `flags` WHERE `id` = NEW.`flag_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `convex_variant_version_after_update`
AFTER UPDATE ON `variants`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1
  WHERE `app_id` = (SELECT `app_id` FROM `flags` WHERE `id` = NEW.`flag_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `convex_variant_version_after_delete`
AFTER DELETE ON `variants`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1
  WHERE `app_id` = (SELECT `app_id` FROM `flags` WHERE `id` = OLD.`flag_id`);
END;
--> statement-breakpoint

CREATE TRIGGER `convex_segment_version_after_insert`
AFTER INSERT ON `segments`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1 WHERE `app_id` = NEW.`app_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `convex_segment_version_after_update`
AFTER UPDATE ON `segments`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1 WHERE `app_id` = NEW.`app_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `convex_segment_version_after_delete`
AFTER DELETE ON `segments`
BEGIN
  UPDATE `environments` SET `config_version` = `config_version` + 1 WHERE `app_id` = OLD.`app_id`;
END;
--> statement-breakpoint

CREATE TRIGGER `convex_environment_version_delivery_after_update`
AFTER UPDATE OF `config_version` ON `environments`
WHEN NEW.`config_version` > OLD.`config_version`
BEGIN
  INSERT OR IGNORE INTO `config_webhook_deliveries` (
    `delivery_id`, `installation_id`, `app_id`, `environment_id`, `environment_version`,
    `body_json`, `state`, `attempt_count`, `next_attempt_at`, `created_at`
  )
  SELECT
    substr(replace(installation.`installation_id`, '-', ''), 1, 8) || '-' ||
    substr(replace(installation.`installation_id`, '-', ''), 9, 4) || '-' ||
    substr(replace(installation.`installation_id`, '-', ''), 13, 4) || '-' ||
    substr(replace(installation.`installation_id`, '-', ''), 17, 4) || '-' ||
    substr(replace(installation.`installation_id`, '-', ''), 21, 4) || printf('%08x', NEW.`config_version`),
    installation.`installation_id`, NEW.`app_id`, NEW.`id`, NEW.`config_version`,
    json_object(
      'deliveryId',
        substr(replace(installation.`installation_id`, '-', ''), 1, 8) || '-' ||
        substr(replace(installation.`installation_id`, '-', ''), 9, 4) || '-' ||
        substr(replace(installation.`installation_id`, '-', ''), 13, 4) || '-' ||
        substr(replace(installation.`installation_id`, '-', ''), 17, 4) || '-' ||
        substr(replace(installation.`installation_id`, '-', ''), 21, 4) || printf('%08x', NEW.`config_version`),
      'type', 'config.changed', 'appId', NEW.`app_id`,
      'environmentId', NEW.`id`, 'environmentVersion', NEW.`config_version`,
      'changed', json_object('entity', 'environment', 'id', NEW.`id`)
    ),
    'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM `convex_installations` installation
  WHERE installation.`app_id` = NEW.`app_id` AND installation.`environment_id` = NEW.`id` AND installation.`status` = 'active';
END;
