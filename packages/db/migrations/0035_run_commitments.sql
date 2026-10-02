ALTER TABLE `runs` ADD `analysis_version` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD `target_n_source` text CHECK (`target_n_source` IN ('caller', 'default'));
--> statement-breakpoint
ALTER TABLE `runs` ADD `planned_duration_days` integer CHECK (`planned_duration_days` > 0);
--> statement-breakpoint
ALTER TABLE `runs` ADD `planned_duration_override_reason` text;
