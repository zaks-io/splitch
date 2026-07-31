CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`operation` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`target_version` text NOT NULL,
	`policy_contexts` text NOT NULL,
	`diff` text NOT NULL,
	`status` text NOT NULL,
	`proposed_by` text NOT NULL,
	`proposed_via` text NOT NULL,
	`proposed_at` text NOT NULL,
	`resolved_at` text,
	`resulting_target_version` text,
	`resulting_resource_type` text,
	`resulting_resource_id` text,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approval_requests_actor_idempotency_unique` ON `approval_requests` (`app_id`,`proposed_by`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `approval_requests_app_created_idx` ON `approval_requests` (`app_id`,`proposed_at`,`id`);
--> statement-breakpoint
CREATE INDEX `approval_requests_app_status_idx` ON `approval_requests` (`app_id`,`status`);
--> statement-breakpoint
CREATE INDEX `approval_requests_app_target_idx` ON `approval_requests` (`app_id`,`target_type`);
--> statement-breakpoint
CREATE TABLE `approval_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`approval_request_id` text NOT NULL,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`reviewed_by` text NOT NULL,
	`reviewed_via` text NOT NULL,
	`reviewed_at` text NOT NULL,
	`reason` text,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`resulting_target_version` text,
	`resulting_resource_type` text,
	`resulting_resource_id` text,
	`error_code` text,
	`error_details` text,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approval_request_id`) REFERENCES `approval_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approval_reviews_actor_idempotency_unique` ON `approval_reviews` (`approval_request_id`,`reviewed_by`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `approval_reviews_request_created_idx` ON `approval_reviews` (`app_id`,`approval_request_id`,`reviewed_at`,`id`);
