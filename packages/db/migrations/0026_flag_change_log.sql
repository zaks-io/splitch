-- Flag-domain change log + Sentry change-tracking installations.
--
-- flag_change_events is append-only history written exclusively by the triggers
-- below. It carries NO foreign keys on purpose: an audit record must outlive the
-- row it audits, and an AFTER DELETE trigger inserting a row that referenced the
-- just-deleted parent would violate the constraint and abort the delete. Tenant
-- scoping is enforced in the data-access seam like every other table (ADR-0018).
--
-- changed_at is written as full ISO 8601 UTC by strftime rather than
-- CURRENT_TIMESTAMP (which yields "YYYY-MM-DD HH:MM:SS", no T, no zone) so the
-- log has one format regardless of which trigger produced the row.

ALTER TABLE `flag_configs` ADD `updated_by` text;
--> statement-breakpoint
ALTER TABLE `flag_configs` ADD `updated_via` text;
--> statement-breakpoint

CREATE TABLE `flag_change_events` (
  `seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `app_id` text NOT NULL,
  `environment_id` text,
  `flag_id` text NOT NULL,
  `flag_key` text NOT NULL,
  `action` text NOT NULL CHECK (`action` IN ('created', 'updated', 'deleted')),
  `target_type` text NOT NULL CHECK (`target_type` IN ('flag', 'flag_config', 'variant', 'targeting_rule', 'run')),
  `actor_ref` text,
  `actor_via` text,
  `changed_at` text NOT NULL,
  `diff_json` text
);
--> statement-breakpoint
CREATE INDEX `flag_change_events_scope_seq_idx` ON `flag_change_events` (`app_id`, `environment_id`, `seq`);
--> statement-breakpoint
CREATE INDEX `flag_change_events_changed_at_idx` ON `flag_change_events` (`changed_at`);
--> statement-breakpoint

CREATE TABLE `sentry_installations` (
  `installation_id` text PRIMARY KEY NOT NULL,
  `app_id` text NOT NULL REFERENCES `apps`(`id`),
  `environment_id` text NOT NULL REFERENCES `environments`(`id`),
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
CREATE INDEX `sentry_installations_due_idx` ON `sentry_installations` (`status`, `next_attempt_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `sentry_installations_scope_id_unique` ON `sentry_installations` (`app_id`, `environment_id`, `installation_id`);
--> statement-breakpoint
-- One Sentry organization per Environment: Sentry's change-tracking payload has
-- no environment field, so a second active installation on the same Environment
-- would double-report every change into the same org.
CREATE UNIQUE INDEX `sentry_installations_active_scope_unique` ON `sentry_installations` (`app_id`, `environment_id`) WHERE `status` = 'active';
--> statement-breakpoint

-- Flag DEFINITION (App-level; environment_id is NULL by ADR-0027).
CREATE TRIGGER `flag_change_flag_after_insert`
AFTER INSERT ON `flags`
BEGIN
  INSERT INTO `flag_change_events` (
    `app_id`, `environment_id`, `flag_id`, `flag_key`, `action`, `target_type`,
    `actor_ref`, `actor_via`, `changed_at`, `diff_json`
  ) VALUES (
    NEW.`app_id`, NULL, NEW.`id`, NEW.`key`, 'created', 'flag',
    NEW.`created_by`, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    json_object('name', NEW.`name`, 'defaultVariantId', NEW.`default_variant_id`)
  );
END;
--> statement-breakpoint
CREATE TRIGGER `flag_change_flag_after_update`
AFTER UPDATE ON `flags`
BEGIN
  INSERT INTO `flag_change_events` (
    `app_id`, `environment_id`, `flag_id`, `flag_key`, `action`, `target_type`,
    `actor_ref`, `actor_via`, `changed_at`, `diff_json`
  ) VALUES (
    NEW.`app_id`, NULL, NEW.`id`, NEW.`key`, 'updated', 'flag',
    NEW.`updated_by`, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    json_object(
      'key', json_array(OLD.`key`, NEW.`key`),
      'name', json_array(OLD.`name`, NEW.`name`),
      'defaultVariantId', json_array(OLD.`default_variant_id`, NEW.`default_variant_id`)
    )
  );
END;
--> statement-breakpoint
CREATE TRIGGER `flag_change_flag_after_delete`
AFTER DELETE ON `flags`
BEGIN
  INSERT INTO `flag_change_events` (
    `app_id`, `environment_id`, `flag_id`, `flag_key`, `action`, `target_type`,
    `actor_ref`, `actor_via`, `changed_at`, `diff_json`
  ) VALUES (
    OLD.`app_id`, NULL, OLD.`id`, OLD.`key`, 'deleted', 'flag',
    OLD.`updated_by`, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
  );
END;
--> statement-breakpoint

-- Per-Environment CONFIGURATION.
--
-- There is deliberately NO after-insert trigger. A flag_configs row is only ever
-- born from `ensureInitialFlagConfig`, which back-fills a disabled default
-- either when a Flag is created (already logged as 'created' at App level) or
-- when an Environment is created (an Environment event, not N Flag changes).
-- Logging the insert would report one Flag creation as 1 + one-row-per-
-- Environment changes, all stamped the same instant and none of them a decision
-- anyone made about the Flag.
CREATE TRIGGER `flag_change_config_after_update`
AFTER UPDATE ON `flag_configs`
BEGIN
  INSERT INTO `flag_change_events` (
    `app_id`, `environment_id`, `flag_id`, `flag_key`, `action`, `target_type`,
    `actor_ref`, `actor_via`, `changed_at`, `diff_json`
  ) SELECT
    NEW.`app_id`, NEW.`environment_id`, NEW.`flag_id`, flag.`key`, 'updated', 'flag_config',
    NEW.`updated_by`, NEW.`updated_via`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    json_object(
      'enabled', json_array(OLD.`enabled`, NEW.`enabled`),
      'rollout', json_array(OLD.`rollout`, NEW.`rollout`),
      'defaultVariantId', json_array(OLD.`default_variant_id`, NEW.`default_variant_id`),
      'availableVariantNames', json_array(OLD.`available_variant_names`, NEW.`available_variant_names`)
    )
  FROM `flags` flag WHERE flag.`id` = NEW.`flag_id`;
END;
--> statement-breakpoint
-- The Flag is gone from this Environment even though the App-level DEFINITION
-- may survive, so an Environment-scoped consumer must see a delete.
CREATE TRIGGER `flag_change_config_after_delete`
AFTER DELETE ON `flag_configs`
BEGIN
  INSERT INTO `flag_change_events` (
    `app_id`, `environment_id`, `flag_id`, `flag_key`, `action`, `target_type`,
    `actor_ref`, `actor_via`, `changed_at`, `diff_json`
  ) SELECT
    OLD.`app_id`, OLD.`environment_id`, OLD.`flag_id`, flag.`key`, 'deleted', 'flag_config',
    OLD.`updated_by`, OLD.`updated_via`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
  FROM `flags` flag WHERE flag.`id` = OLD.`flag_id`;
END;
--> statement-breakpoint

-- Variant catalog (App-level). Changing a Variant's value changes what every
-- Environment serves, so it is an 'updated' on the owning Flag.
--
-- `actor_ref` is NULL, not `flag.updated_by`: the Variant write path never bumps
-- the Flag row, so `flags.updated_by` is whoever last renamed the Flag, not
-- whoever changed this Variant. Naming the wrong person in an audit record is
-- worse than admitting the record does not know.
CREATE TRIGGER `flag_change_variant_after_insert`
AFTER INSERT ON `variants`
BEGIN
  INSERT INTO `flag_change_events` (
    `app_id`, `environment_id`, `flag_id`, `flag_key`, `action`, `target_type`,
    `actor_ref`, `actor_via`, `changed_at`, `diff_json`
  ) SELECT
    flag.`app_id`, NULL, NEW.`flag_id`, flag.`key`, 'updated', 'variant',
    NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    json_object('variant', NEW.`name`, 'change', 'added')
  FROM `flags` flag WHERE flag.`id` = NEW.`flag_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `flag_change_variant_after_update`
AFTER UPDATE ON `variants`
BEGIN
  INSERT INTO `flag_change_events` (
    `app_id`, `environment_id`, `flag_id`, `flag_key`, `action`, `target_type`,
    `actor_ref`, `actor_via`, `changed_at`, `diff_json`
  ) SELECT
    flag.`app_id`, NULL, NEW.`flag_id`, flag.`key`, 'updated', 'variant',
    NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    json_object('variant', json_array(OLD.`name`, NEW.`name`), 'value', json_array(OLD.`value`, NEW.`value`))
  FROM `flags` flag WHERE flag.`id` = NEW.`flag_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `flag_change_variant_after_delete`
AFTER DELETE ON `variants`
BEGIN
  INSERT INTO `flag_change_events` (
    `app_id`, `environment_id`, `flag_id`, `flag_key`, `action`, `target_type`,
    `actor_ref`, `actor_via`, `changed_at`, `diff_json`
  ) SELECT
    flag.`app_id`, NULL, OLD.`flag_id`, flag.`key`, 'updated', 'variant',
    NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    json_object('variant', OLD.`name`, 'change', 'removed')
  FROM `flags` flag WHERE flag.`id` = OLD.`flag_id`;
END;
--> statement-breakpoint

-- Targeting rules (per-Environment).
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
--> statement-breakpoint

-- Runs. Starting or ending a Run changes which arm traffic receives, which is a
-- behavioural change to the Flag even though no Flag row was touched.
CREATE TRIGGER `flag_change_run_after_insert`
AFTER INSERT ON `runs`
BEGIN
  INSERT INTO `flag_change_events` (
    `app_id`, `environment_id`, `flag_id`, `flag_key`, `action`, `target_type`,
    `actor_ref`, `actor_via`, `changed_at`, `diff_json`
  ) SELECT
    NEW.`app_id`, NEW.`environment_id`, experiment.`flag_id`, flag.`key`, 'updated', 'run',
    NEW.`created_by`, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    json_object('runId', NEW.`id`, 'runNumber', NEW.`run_number`, 'status', NEW.`status`, 'allocation', NEW.`allocation`)
  FROM `experiments` experiment JOIN `flags` flag ON flag.`id` = experiment.`flag_id`
  WHERE experiment.`id` = NEW.`experiment_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `flag_change_run_after_update`
AFTER UPDATE OF `status` ON `runs`
WHEN NEW.`status` <> OLD.`status`
BEGIN
  INSERT INTO `flag_change_events` (
    `app_id`, `environment_id`, `flag_id`, `flag_key`, `action`, `target_type`,
    `actor_ref`, `actor_via`, `changed_at`, `diff_json`
  ) SELECT
    NEW.`app_id`, NEW.`environment_id`, experiment.`flag_id`, flag.`key`, 'updated', 'run',
    NEW.`created_by`, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    json_object('runId', NEW.`id`, 'status', json_array(OLD.`status`, NEW.`status`), 'endReason', NEW.`end_reason`)
  FROM `experiments` experiment JOIN `flags` flag ON flag.`id` = experiment.`flag_id`
  WHERE experiment.`id` = NEW.`experiment_id`;
END;
