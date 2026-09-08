ALTER TABLE `approval_requests` ADD `policy_guard_contexts` text;
--> statement-breakpoint
CREATE TABLE `experiment_conclusions` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`experiment_id` text NOT NULL,
	`run_id` text NOT NULL,
	`selected_variant` text NOT NULL,
	`config_hash` text NOT NULL,
	`result_token` text NOT NULL,
	`data_watermark` text NOT NULL,
	`result_snapshot` text NOT NULL,
	`decision_failures` text NOT NULL,
	`decision_checks` text NOT NULL,
	`target_environment_id` text NOT NULL,
	`target_flag_id` text NOT NULL,
	`target_config_version` integer NOT NULL,
	`proposed_flag_configuration` text NOT NULL,
	`reason` text,
	`concluded_by` text NOT NULL,
	`concluded_via` text NOT NULL,
	`concluded_at` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `experiment_conclusions_run_unique` ON `experiment_conclusions` (`run_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `experiment_conclusions_actor_idempotency_unique` ON `experiment_conclusions` (`app_id`,`concluded_by`,`idempotency_key`);
--> statement-breakpoint
CREATE TABLE `conclusion_approval_requests` (
	`app_id` text NOT NULL,
	`conclusion_id` text NOT NULL,
	`approval_request_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`conclusion_id`, `ordinal`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conclusion_id`) REFERENCES `experiment_conclusions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approval_request_id`) REFERENCES `approval_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conclusion_approval_requests_request_unique` ON `conclusion_approval_requests` (`approval_request_id`);
