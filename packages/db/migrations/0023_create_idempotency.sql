ALTER TABLE `apps` ADD `create_idempotency_key` text;
ALTER TABLE `apps` ADD `create_request_hash` text;
ALTER TABLE `apps` ADD `create_response` text;
CREATE UNIQUE INDEX `apps_create_idempotency_unique`
ON `apps` (`organization_id`, `created_by`, `create_idempotency_key`);

ALTER TABLE `flags` ADD `create_idempotency_key` text;
ALTER TABLE `flags` ADD `create_request_hash` text;
ALTER TABLE `flags` ADD `create_response` text;
CREATE UNIQUE INDEX `flags_create_idempotency_unique`
ON `flags` (`app_id`, `created_by`, `create_idempotency_key`);

CREATE UNIQUE INDEX `variants_flag_name_unique`
ON `variants` (`flag_id`, `name`);
