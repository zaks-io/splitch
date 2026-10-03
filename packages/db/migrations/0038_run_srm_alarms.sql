CREATE TABLE `run_srm_alarms` (
	`run_id` text NOT NULL,
	`srm_kind` text NOT NULL,
	`first_crossed_at` text NOT NULL,
	`watermark` text NOT NULL,
	`p_value` real NOT NULL,
	`analysis_version` text NOT NULL,
	`app_id` text NOT NULL,
	`environment_id` text NOT NULL,
	PRIMARY KEY(`run_id`, `srm_kind`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action
);
