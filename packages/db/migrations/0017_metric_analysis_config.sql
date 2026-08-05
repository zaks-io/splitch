-- Guardrail bounds and variance-reduction knobs move from "documented but
-- unstorable" to real columns. Null on a Metric means the engine default, and
-- Run Start resolves each Metric and freezes the answer on the Run, so a
-- re-analysis reproduces the original numbers after the Metric is edited.
ALTER TABLE `metrics` ADD `downside_threshold_pct` real;
--> statement-breakpoint
ALTER TABLE `metrics` ADD `winsorize` integer;
--> statement-breakpoint
ALTER TABLE `metrics` ADD `winsorize_pct` real;
--> statement-breakpoint
ALTER TABLE `metrics` ADD `cuped_coverage_threshold_pct` real;
--> statement-breakpoint
ALTER TABLE `runs` ADD `metric_variance_config` text DEFAULT '[]' NOT NULL;
