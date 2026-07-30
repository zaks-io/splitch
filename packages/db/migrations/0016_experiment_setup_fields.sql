ALTER TABLE `experiments` ADD `owner` text;
--> statement-breakpoint
ALTER TABLE `experiments` ADD `tags` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `runs` ADD `activation_metric_id` text;
