ALTER TABLE `organizations` ADD `claim_acquisition_token` text;
ALTER TABLE `claim_idempotency` ADD `organization_hash` text NOT NULL DEFAULT '';
ALTER TABLE `claim_idempotency` ADD `app_hash` text NOT NULL DEFAULT '';
ALTER TABLE `claim_idempotency` ADD `verified_user_hash` text NOT NULL DEFAULT '';
