CREATE TABLE `claim_verifications` (
  `id` text PRIMARY KEY NOT NULL,
  `provisional_user_hash` text NOT NULL,
  `email_hash` text NOT NULL,
  `expires_at` text NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `verified_at` text,
  `consumed_at` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `claim_consent_attempts` (
  `id` text PRIMARY KEY NOT NULL,
  `verification_id` text NOT NULL,
  `existing_user_hash` text NOT NULL,
  `expires_at` text NOT NULL,
  `approved_at` text,
  `consumed_at` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`verification_id`) REFERENCES `claim_verifications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `claim_idempotency` (
  `key_hash` text PRIMARY KEY NOT NULL,
  `verification_id` text NOT NULL,
  `provisional_user_hash` text NOT NULL,
  `email_hash` text NOT NULL,
  `completed_at` text NOT NULL,
  `expires_at` text NOT NULL,
  FOREIGN KEY (`verification_id`) REFERENCES `claim_verifications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `claim_verifications_subject_email_idx` ON `claim_verifications` (`provisional_user_hash`,`email_hash`);
--> statement-breakpoint
CREATE INDEX `claim_consent_attempts_verification_idx` ON `claim_consent_attempts` (`verification_id`);
