-- SPL-450: Targeting Rule identity is one Flag Configuration
-- (app_id, environment_id, flag_id, id). The same id may exist on another
-- Flag or Environment. `id` is no longer a global PRIMARY KEY.
--
-- DROP TABLE removes the convex config-version and flag-change triggers that
-- fire on targeting_rules; they are recreated after the rename so the applied
-- schema stays exact.

PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_targeting_rules` (
	`id` text NOT NULL,
	`app_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`flag_id` text NOT NULL,
	`priority` integer NOT NULL,
	`conditions` text NOT NULL,
	`segment_id` text,
	`variant_id` text,
	`percentage_rollout` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`flag_id`) REFERENCES `flags`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`app_id`,`segment_id`) REFERENCES `segments`(`app_id`,`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
INSERT INTO `__new_targeting_rules`("id", "app_id", "environment_id", "flag_id", "priority", "conditions", "segment_id", "variant_id", "percentage_rollout", "created_at", "updated_at") SELECT "id", "app_id", "environment_id", "flag_id", "priority", "conditions", "segment_id", "variant_id", "percentage_rollout", "created_at", "updated_at" FROM `targeting_rules`;--> statement-breakpoint
DROP TABLE `targeting_rules`;--> statement-breakpoint
ALTER TABLE `__new_targeting_rules` RENAME TO `targeting_rules`;--> statement-breakpoint
CREATE UNIQUE INDEX `targeting_rules_scope_id_unique` ON `targeting_rules` (`app_id`,`environment_id`,`flag_id`,`id`);--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint

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

CREATE TRIGGER `flag_change_rule_after_insert`
AFTER INSERT ON `targeting_rules`
BEGIN
  INSERT INTO `flag_change_events` (
    `app_id`, `environment_id`, `flag_id`, `flag_key`, `action`, `target_type`,
    `actor_ref`, `actor_via`, `changed_at`, `diff_json`
  ) SELECT
    NEW.`app_id`, NEW.`environment_id`, NEW.`flag_id`, flag.`key`, 'updated', 'targeting_rule',
    NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    json_object('ruleId', NEW.`id`, 'priority', NEW.`priority`, 'change', 'added')
  FROM `flags` flag WHERE flag.`id` = NEW.`flag_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `flag_change_rule_after_update`
AFTER UPDATE ON `targeting_rules`
BEGIN
  INSERT INTO `flag_change_events` (
    `app_id`, `environment_id`, `flag_id`, `flag_key`, `action`, `target_type`,
    `actor_ref`, `actor_via`, `changed_at`, `diff_json`
  ) SELECT
    NEW.`app_id`, NEW.`environment_id`, NEW.`flag_id`, flag.`key`, 'updated', 'targeting_rule',
    NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    json_object(
      'ruleId', NEW.`id`,
      'priority', json_array(OLD.`priority`, NEW.`priority`),
      'conditions', json_array(OLD.`conditions`, NEW.`conditions`),
      'variantId', json_array(OLD.`variant_id`, NEW.`variant_id`),
      'percentageRollout', json_array(OLD.`percentage_rollout`, NEW.`percentage_rollout`)
    )
  FROM `flags` flag WHERE flag.`id` = NEW.`flag_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `flag_change_rule_after_delete`
AFTER DELETE ON `targeting_rules`
BEGIN
  INSERT INTO `flag_change_events` (
    `app_id`, `environment_id`, `flag_id`, `flag_key`, `action`, `target_type`,
    `actor_ref`, `actor_via`, `changed_at`, `diff_json`
  ) SELECT
    OLD.`app_id`, OLD.`environment_id`, OLD.`flag_id`, flag.`key`, 'updated', 'targeting_rule',
    NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    json_object('ruleId', OLD.`id`, 'change', 'removed')
  FROM `flags` flag WHERE flag.`id` = OLD.`flag_id`;
END;
