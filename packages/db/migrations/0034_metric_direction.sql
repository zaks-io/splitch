ALTER TABLE `metrics` ADD `direction` text CHECK (`direction` IN ('higher_is_better', 'lower_is_better'));
