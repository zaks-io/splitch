CREATE TABLE `claim_idempotency_next` (
  `key_hash` text NOT NULL,
  `verification_id` text NOT NULL,
  `provisional_user_hash` text NOT NULL,
  `email_hash` text NOT NULL,
  `organization_hash` text NOT NULL,
  `app_hash` text NOT NULL,
  `verified_user_hash` text NOT NULL,
  `completed_at` text,
  `expires_at` text NOT NULL,
  PRIMARY KEY(`key_hash`, `provisional_user_hash`, `email_hash`, `organization_hash`, `app_hash`, `verified_user_hash`),
  FOREIGN KEY (`verification_id`) REFERENCES `claim_verifications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `claim_idempotency_next` (
  `key_hash`, `verification_id`, `provisional_user_hash`, `email_hash`,
  `organization_hash`, `app_hash`, `verified_user_hash`, `completed_at`, `expires_at`
)
SELECT
  `key_hash`, `verification_id`, `provisional_user_hash`, `email_hash`,
  `organization_hash`, `app_hash`, `verified_user_hash`, `completed_at`, `expires_at`
FROM `claim_idempotency`;
--> statement-breakpoint
DROP TABLE `claim_idempotency`;
--> statement-breakpoint
ALTER TABLE `claim_idempotency_next` RENAME TO `claim_idempotency`;
--> statement-breakpoint
CREATE INDEX `claim_idempotency_expires_at_idx` ON `claim_idempotency` (`expires_at`);
