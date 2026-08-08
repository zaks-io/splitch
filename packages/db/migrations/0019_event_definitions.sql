CREATE TABLE `event_definitions` (
  `id` text PRIMARY KEY NOT NULL,
  `app_id` text NOT NULL REFERENCES `apps`(`id`),
  `name` text NOT NULL,
  `family` text NOT NULL,
  `display_name` text NOT NULL,
  `description` text,
  `state` text DEFAULT 'draft' NOT NULL,
  `current_published_version_id` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `created_by` text,
  `updated_by` text,
  -- An Event Definition name is a Telemetry Token everywhere it is read: the
  -- hot-config KV key, the ingest contract and the analysis pipes. A legacy
  -- `event_name` outside that shape has no representation downstream, so the
  -- backfill below must abort on it rather than admit a row the read path will
  -- reject later for the whole App. Remediation is renaming the Metric's Event
  -- before deploying this migration.
  CONSTRAINT `event_definitions_name_is_telemetry_token` CHECK (
    length(`name`) BETWEEN 1 AND 64
    AND `name` GLOB '[A-Za-z0-9]*'
    AND `name` NOT GLOB '*[^A-Za-z0-9_.:-]*'
  ),
  CONSTRAINT `event_definitions_state_is_valid` CHECK (
    `state` IN ('draft', 'incomplete', 'published')
    AND ((`state` = 'published') = (`current_published_version_id` IS NOT NULL))
  )
);
CREATE UNIQUE INDEX `event_definitions_app_name_unique` ON `event_definitions` (`app_id`,`name`);

CREATE TABLE `event_definition_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `app_id` text NOT NULL REFERENCES `apps`(`id`),
  `event_definition_id` text NOT NULL REFERENCES `event_definitions`(`id`),
  `version` integer NOT NULL,
  `schema_hash` text NOT NULL,
  `entity_type` text,
  `fields` text NOT NULL,
  `dimensions` text NOT NULL,
  `published_at` text NOT NULL,
  `published_by` text
);
CREATE UNIQUE INDEX `event_definition_versions_number_unique` ON `event_definition_versions` (`event_definition_id`,`version`);

-- Legacy Metrics identified their Event by name. Preserve that binding before
-- rebuilding the table: dropping it would leave the new read path no authority
-- from which to recover an Event Definition.
--
-- A legacy Metric carries neither an Entity type nor a numeric domain. Preserve
-- its Event binding as explicitly incomplete without creating a Version that
-- falsely claims to be publishable. The Metric write path permits edits that
-- keep this legacy binding unchanged; accepting new facts still requires the
-- operator to publish a complete Version through the Control Plane.
INSERT INTO `event_definitions` (
  `id`, `app_id`, `name`, `family`, `display_name`, `state`,
  `current_published_version_id`, `created_at`, `updated_at`
)
SELECT
  'event_definition_migrated_' || lower(hex(CAST(`app_id` AS blob))) || '_' || lower(hex(CAST(`event_name` AS blob))),
  `app_id`,
  `event_name`,
  'metric',
  `event_name`,
  'incomplete',
  NULL,
  min(`created_at`),
  min(`created_at`)
FROM `metrics`
WHERE `event_name` IS NOT NULL
GROUP BY `app_id`, `event_name`;

CREATE TABLE `metrics_v2` (
  `id` text PRIMARY KEY NOT NULL,
  `app_id` text NOT NULL REFERENCES `apps`(`id`),
  `key` text NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `kind` text NOT NULL,
  `event_definition_id` text,
  `event_field_name` text,
  `denominator_metric_id` text,
  `downside_threshold_pct` real,
  `winsorize` integer,
  `winsorize_pct` real,
  `cuped` integer,
  `cuped_coverage_threshold_pct` real,
  `created_at` text NOT NULL,
  `created_by` text
);

INSERT INTO `metrics_v2` (
  `id`, `app_id`, `key`, `name`, `description`, `kind`,
  `event_definition_id`, `event_field_name`,
  `denominator_metric_id`, `downside_threshold_pct`, `winsorize`,
  `winsorize_pct`, `cuped`, `cuped_coverage_threshold_pct`, `created_at`, `created_by`
)
SELECT
  `id`, `app_id`, `key`, `name`, `description`, `kind`,
  CASE
    WHEN `event_name` IS NULL THEN NULL
    ELSE 'event_definition_migrated_' || lower(hex(CAST(`app_id` AS blob))) || '_' || lower(hex(CAST(`event_name` AS blob)))
  END,
  `event_value_field`,
  `denominator_metric_id`, `downside_threshold_pct`, `winsorize`,
  `winsorize_pct`, `cuped`, `cuped_coverage_threshold_pct`, `created_at`, `created_by`
FROM `metrics`;

DROP TABLE `metrics`;
ALTER TABLE `metrics_v2` RENAME TO `metrics`;
CREATE UNIQUE INDEX `metrics_app_key_unique` ON `metrics` (`app_id`,`key`);
