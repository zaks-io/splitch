CREATE TABLE `app_deletion_sagas` (
	`app_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`delete_before_ts` text NOT NULL,
	`phase` text NOT NULL CHECK (`phase` IN ('started', 'd1_deleted', 'complete')),
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
