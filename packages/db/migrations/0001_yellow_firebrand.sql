DROP INDEX `trusted_idps_issuer_unique`;--> statement-breakpoint
ALTER TABLE `trusted_idps` ADD `org_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `trusted_idps_org_issuer_unique` ON `trusted_idps` (`org_id`,`issuer`);