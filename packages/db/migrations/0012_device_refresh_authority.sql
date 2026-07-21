ALTER TABLE `device_refresh_sessions` ADD `user_id` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `device_refresh_sessions` ADD `provider_organization_id` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `device_refresh_sessions` ADD `selected_app_scope` text NOT NULL DEFAULT '';
