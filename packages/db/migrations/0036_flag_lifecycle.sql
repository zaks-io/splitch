-- Flag lifecycle class, owner, and expiry (plan items 3.4 and 3.5, decision D9).
--
-- Every Flag that existed before this migration lands in `unclassified`: a
-- visible, readable, evaluable state that says nobody has declared why the Flag
-- exists yet. The column default exists only to classify those legacy rows; the
-- Drizzle schema declares no default, so every new write must name a class.
--
-- The owner and expiry requirement for release and experiment Flags lives in the
-- Control Plane seam rather than a CHECK so a refused write answers with the
-- stable FLAG_LIFECYCLE_INCOMPLETE error naming the missing inputs.
ALTER TABLE `flags` ADD `lifecycle_class` text DEFAULT 'unclassified' NOT NULL CHECK (`lifecycle_class` IN ('unclassified', 'release', 'experiment', 'ops', 'permission'));
--> statement-breakpoint
ALTER TABLE `flags` ADD `owner` text;
--> statement-breakpoint
-- ISO 8601 UTC text, so the lexicographic comparison IS the chronological one.
ALTER TABLE `flags` ADD `expires_at` text;
--> statement-breakpoint
-- Serves the expired-but-live read: one App's Flags that carry an expiry, oldest first.
CREATE INDEX `flags_app_expires_at_idx` ON `flags` (`app_id`, `expires_at`) WHERE `expires_at` IS NOT NULL;
