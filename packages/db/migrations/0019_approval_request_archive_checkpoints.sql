CREATE TABLE `approval_request_archive_checkpoints` (
	`approval_request_id` text NOT NULL,
	`app_id` text NOT NULL,
	`archive_version` integer NOT NULL,
	`content_checksum` text NOT NULL,
	`row_count` integer NOT NULL,
	`proposed_at` text NOT NULL,
	`resolved_at` text NOT NULL,
	`archived_at` text NOT NULL,
	PRIMARY KEY(`approval_request_id`, `archive_version`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `approval_request_archive_checkpoints_app_idx` ON `approval_request_archive_checkpoints` (`app_id`,`proposed_at`,`approval_request_id`);
