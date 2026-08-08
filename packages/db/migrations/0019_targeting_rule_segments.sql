PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `segments_app_id_id_unique` ON `segments` (`app_id`,`id`);--> statement-breakpoint
CREATE TABLE `__new_targeting_rules` (
	`id` text PRIMARY KEY NOT NULL,
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
INSERT INTO `__new_targeting_rules`("id", "app_id", "environment_id", "flag_id", "priority", "conditions", "segment_id", "variant_id", "percentage_rollout", "created_at", "updated_at") SELECT "id", "app_id", "environment_id", "flag_id", "priority", "conditions", NULL, "variant_id", "percentage_rollout", "created_at", "updated_at" FROM `targeting_rules`;--> statement-breakpoint
DROP TABLE `targeting_rules`;--> statement-breakpoint
ALTER TABLE `__new_targeting_rules` RENAME TO `targeting_rules`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
-- SPL-280: what a failed application left behind, so an exact-key replay repeats the first refusal.
ALTER TABLE `approval_reviews` ADD `target_state` text;
