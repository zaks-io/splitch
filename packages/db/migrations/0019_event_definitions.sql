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

-- Legacy Metrics identified their Event by name. Preserve that binding before
-- rebuilding the table: dropping it would leave the new read path no authority
-- from which to recover an Event Definition.
INSERT INTO `event_definitions` (
  `id`, `app_id`, `name`, `family`, `display_name`,
  `current_published_version_id`, `created_at`, `updated_at`
)
SELECT
  'event_definition_migrated_' || lower(hex(CAST(`app_id` AS blob))) || '_' || lower(hex(CAST(`event_name` AS blob))),
  `app_id`,
  `event_name`,
  'metric',
  `event_name`,
  NULL,
  min(`created_at`),
  min(`created_at`)
FROM `metrics`
WHERE `event_name` IS NOT NULL
GROUP BY `app_id`, `event_name`;

INSERT INTO `event_definition_versions` (
  `id`, `app_id`, `event_definition_id`, `version`, `schema_hash`,
  `entity_type`, `fields`, `dimensions`, `published_at`
)
SELECT
  'event_definition_version_migrated_' || lower(hex(CAST(`legacy`.`app_id` AS blob))) || '_' || lower(hex(CAST(`legacy`.`event_name` AS blob))),
  `legacy`.`app_id`,
  'event_definition_migrated_' || lower(hex(CAST(`legacy`.`app_id` AS blob))) || '_' || lower(hex(CAST(`legacy`.`event_name` AS blob))),
  1,
  'migration:0019:' || lower(hex(CAST(`legacy`.`app_id` AS blob))) || ':' || lower(hex(CAST(`legacy`.`event_name` AS blob))),
  NULL,
  coalesce((
    SELECT json_group_array(json(`field`.`definition`))
    FROM (
      SELECT json_object(
        'name', `field_metric`.`event_value_field`,
        'type', 'number',
        'required', json('false'),
        'numberKind', CASE
          WHEN max(`field_metric`.`kind` = 'revenue') = 1 THEN 'amount'
          WHEN max(`field_metric`.`kind` = 'count') = 1 THEN 'count'
          ELSE 'measurement'
        END
      ) AS `definition`
      FROM `metrics` AS `field_metric`
      WHERE `field_metric`.`app_id` = `legacy`.`app_id`
        AND `field_metric`.`event_name` = `legacy`.`event_name`
        AND `field_metric`.`event_value_field` IS NOT NULL
      GROUP BY `field_metric`.`event_value_field`
      ORDER BY `field_metric`.`event_value_field`
    ) AS `field`
  ), '[]'),
  '[]',
  min(`legacy`.`created_at`)
FROM `metrics` AS `legacy`
WHERE `legacy`.`event_name` IS NOT NULL
GROUP BY `legacy`.`app_id`, `legacy`.`event_name`;

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
