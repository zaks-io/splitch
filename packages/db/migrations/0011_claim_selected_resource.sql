ALTER TABLE `claim_verifications` ADD `selected_resource` text;
--> statement-breakpoint
ALTER TABLE `claim_idempotency` ADD `selected_resource` text;
