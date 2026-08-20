CREATE TABLE `app_deletion_sagas_next` (
	`app_id` text PRIMARY KEY NOT NULL,
	`generation_id` text NOT NULL,
	`organization_id` text,
	`actor_id` text,
	`delete_before_ts` text,
	`retry_actor_hash` text,
	`organization_scope_hash` text,
	`phase` text NOT NULL CHECK (`phase` IN ('started', 'd1_deleted', 'complete')),
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

INSERT INTO `app_deletion_sagas_next` (
	`app_id`, `generation_id`, `organization_id`, `actor_id`, `delete_before_ts`,
	`retry_actor_hash`, `organization_scope_hash`, `phase`, `created_at`, `updated_at`
)
SELECT
	`app_id`, 'legacy:' || `app_id` || ':' || `created_at`, `organization_id`, `actor_id`,
	`delete_before_ts`, `retry_actor_hash`, `organization_scope_hash`, `phase`, `created_at`,
	`updated_at`
FROM `app_deletion_sagas`;

DROP TABLE `app_deletion_sagas`;
ALTER TABLE `app_deletion_sagas_next` RENAME TO `app_deletion_sagas`;
