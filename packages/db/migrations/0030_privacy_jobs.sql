ALTER TABLE `privacy_requests` ADD `idempotency_key` text;
ALTER TABLE `privacy_requests` ADD `request_hash` text;
CREATE UNIQUE INDEX `privacy_requests_entity_idempotency_unique`
  ON `privacy_requests` (`app_id`, `requested_by`, `request_type`, `idempotency_key`);

CREATE TABLE `privacy_jobs` (
  `job_id` text PRIMARY KEY NOT NULL,
  `request_id` text NOT NULL UNIQUE,
  `kind` text NOT NULL,
  `status` text NOT NULL,
  `store_status_json` text NOT NULL,
  `delete_before_ts` text,
  `identity_version` text NOT NULL,
  `lease_expires_at` text,
  `artifact_key` text,
  `artifact_sha256` text,
  `artifact_expires_at` text,
  `error_code` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`request_id`) REFERENCES `privacy_requests`(`request_id`) ON UPDATE no action ON DELETE no action
);
