CREATE TABLE `app_memberships` (
	`app_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`app_id`, `user_id`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apps_org_key_unique` ON `apps` (`organization_id`,`key`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environments_app_key_unique` ON `environments` (`app_id`,`key`);--> statement-breakpoint
CREATE TABLE `org_memberships` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`org_id`, `user_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`sso_enabled` integer DEFAULT false NOT NULL,
	`is_provisional` integer DEFAULT false NOT NULL,
	`demo_expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trusted_idps` (
	`idp_id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`jwks_uri` text NOT NULL,
	`client_ids` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trusted_idps_issuer_unique` ON `trusted_idps` (`issuer`);--> statement-breakpoint
CREATE TABLE `flag_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`flag_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`available_variant_names` text NOT NULL,
	`default_variant_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`flag_id`) REFERENCES `flags`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `flag_configs_flag_env_unique` ON `flag_configs` (`flag_id`,`environment_id`);--> statement-breakpoint
CREATE TABLE `flags` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`schema` text,
	`default_variant_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`created_by` text,
	`updated_by` text,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `flags_app_key_unique` ON `flags` (`app_id`,`key`);--> statement-breakpoint
CREATE TABLE `segments` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`conditions` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `targeting_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`flag_id` text NOT NULL,
	`priority` integer NOT NULL,
	`conditions` text NOT NULL,
	`variant_id` text,
	`percentage_rollout` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`flag_id`) REFERENCES `flags`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `variants` (
	`id` text PRIMARY KEY NOT NULL,
	`flag_id` text NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`flag_id`) REFERENCES `flags`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`key` text NOT NULL,
	`flag_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`hypothesis` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`targeting_key_field` text NOT NULL,
	`targeting_key_type` text NOT NULL,
	`confidence_level` real DEFAULT 0.95 NOT NULL,
	`default_variant_id` text,
	`metrics` text NOT NULL,
	`guardrail_metrics` text NOT NULL,
	`activation_metric_id` text,
	`conversion_window_ms` integer DEFAULT 0 NOT NULL,
	`dimensions` text NOT NULL,
	`draft_allocation` text,
	`draft_salt` text,
	`draft_targeting_rules` text,
	`draft_segment_ids` text,
	`live_run_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`created_by` text,
	`updated_by` text,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`flag_id`) REFERENCES `flags`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `experiments_app_env_key_unique` ON `experiments` (`app_id`,`environment_id`,`key`);--> statement-breakpoint
CREATE TABLE `metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text NOT NULL,
	`event_name` text NOT NULL,
	`event_value_field` text,
	`denominator_metric_id` text,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metrics_app_key_unique` ON `metrics` (`app_id`,`key`);--> statement-breakpoint
CREATE TABLE `runs` (
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
CREATE UNIQUE INDEX `runs_experiment_salt_unique` ON `runs` (`experiment_id`,`salt`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_experiment_run_number_unique` ON `runs` (`experiment_id`,`run_number`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`key_id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`revoked_at` text,
	`last_rotated_at` text,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `api_keys_key_hash_idx` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `client_keys` (
	`key_id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`key_material` text NOT NULL,
	`origin_allowlist` text,
	`rate_limit_rps` integer,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `entity_deletions` (
	`app_id` text NOT NULL,
	`id_type` text NOT NULL,
	`targeting_key_hash` text NOT NULL,
	`delete_before_ts` text NOT NULL,
	`requested_at` text NOT NULL,
	`completed_at` text,
	PRIMARY KEY(`app_id`, `id_type`, `targeting_key_hash`, `delete_before_ts`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `privacy_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`app_id` text,
	`request_type` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_ref` text NOT NULL,
	`requested_by` text NOT NULL,
	`status` text NOT NULL,
	`received_at` text NOT NULL,
	`ack_due_at` text NOT NULL,
	`response_due_at` text NOT NULL,
	`completed_at` text,
	`denial_reason` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
