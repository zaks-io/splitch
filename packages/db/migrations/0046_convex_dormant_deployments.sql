ALTER TABLE `convex_installations` ADD `deployment_missing_at` text;
--> statement-breakpoint
ALTER TABLE `convex_installations` ADD `deployment_checked_at` text;
--> statement-breakpoint
CREATE INDEX `convex_installations_dormant_check_idx`
  ON `convex_installations` (`deployment_checked_at`, `installation_id`)
  WHERE `status` = 'active' AND `deployment_missing_at` IS NOT NULL;
--> statement-breakpoint
DROP TRIGGER `convex_environment_version_delivery_after_update`;
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
  WHERE installation.`app_id` = NEW.`app_id` AND installation.`environment_id` = NEW.`id` AND installation.`status` = 'active'
    AND installation.`deployment_missing_at` IS NULL;
END;
