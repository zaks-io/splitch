-- Freeze the Control Variant identity on every Experiment Run (SPL-184).
--
-- Existing Runs predate a frozen Control marker. Their Experiment's current
-- default_variant_id is the best-available historical value, so backfill from
-- that before rebuilding the table to enforce NOT NULL. A missing or
-- cross-scoped Experiment/default makes the INSERT into runs_next fail loud.
PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
ALTER TABLE `runs` ADD `control_variant_id` text;
--> statement-breakpoint
UPDATE `runs`
SET `control_variant_id` = (
	SELECT `experiments`.`default_variant_id`
	FROM `experiments`
	WHERE `experiments`.`id` = `runs`.`experiment_id`
		AND `experiments`.`app_id` = `runs`.`app_id`
		AND `experiments`.`environment_id` = `runs`.`environment_id`
)
WHERE `control_variant_id` IS NULL;
--> statement-breakpoint
CREATE TABLE `runs_next` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`experiment_id` text NOT NULL,
	`run_number` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`targeting_key_field` text NOT NULL,
	`targeting_key_type` text NOT NULL,
	`salt` text NOT NULL,
	`allocation` text NOT NULL,
	`variant_set` text NOT NULL,
	`control_variant_id` text NOT NULL,
	`targeting_rules` text NOT NULL,
	`confidence_level` real NOT NULL,
	`horizon` text DEFAULT 'sequential' NOT NULL,
	`target_n` integer,
	`sample_size_locked` integer,
	`decision_family` text NOT NULL,
	`guardrail_decisions` text NOT NULL,
	`config_hash` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`start_reason` text,
	`end_reason` text,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `runs_next` (
	`id`, `app_id`, `environment_id`, `experiment_id`, `run_number`, `status`,
	`targeting_key_field`, `targeting_key_type`, `salt`, `allocation`, `variant_set`,
	`control_variant_id`, `targeting_rules`, `confidence_level`, `horizon`, `target_n`,
	`sample_size_locked`, `decision_family`, `guardrail_decisions`, `config_hash`,
	`started_at`, `ended_at`, `start_reason`, `end_reason`, `created_at`, `created_by`
)
SELECT
	`id`, `app_id`, `environment_id`, `experiment_id`, `run_number`, `status`,
	`targeting_key_field`, `targeting_key_type`, `salt`, `allocation`, `variant_set`,
	`control_variant_id`, `targeting_rules`, `confidence_level`, `horizon`, `target_n`,
	`sample_size_locked`, `decision_family`, `guardrail_decisions`, `config_hash`,
	`started_at`, `ended_at`, `start_reason`, `end_reason`, `created_at`, `created_by`
FROM `runs`;
--> statement-breakpoint
DROP TABLE `runs`;
--> statement-breakpoint
ALTER TABLE `runs_next` RENAME TO `runs`;
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_experiment_salt_unique` ON `runs` (`experiment_id`,`salt`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_experiment_run_number_unique` ON `runs` (`experiment_id`,`run_number`);
--> statement-breakpoint
PRAGMA defer_foreign_keys = OFF;
