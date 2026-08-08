CREATE TABLE `event_definitions` (
  `id` text PRIMARY KEY NOT NULL,
  `app_id` text NOT NULL REFERENCES `apps`(`id`),
  `name` text NOT NULL,
  `family` text NOT NULL,
  `display_name` text NOT NULL,
  `description` text,
  `current_published_version_id` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `created_by` text,
  `updated_by` text
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
  `denominator_metric_id`, `downside_threshold_pct`, `winsorize`,
  `winsorize_pct`, `cuped`, `cuped_coverage_threshold_pct`, `created_at`, `created_by`
)
SELECT
  `id`, `app_id`, `key`, `name`, `description`, `kind`,
  `denominator_metric_id`, `downside_threshold_pct`, `winsorize`,
  `winsorize_pct`, `cuped`, `cuped_coverage_threshold_pct`, `created_at`, `created_by`
FROM `metrics`;

DROP TABLE `metrics`;
ALTER TABLE `metrics_v2` RENAME TO `metrics`;
CREATE UNIQUE INDEX `metrics_app_key_unique` ON `metrics` (`app_id`,`key`);
