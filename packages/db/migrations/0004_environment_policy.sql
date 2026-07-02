ALTER TABLE `environments` ADD `policy` text DEFAULT '{"variantAvailability":"allow","targetingRolloutValue":"allow","enabledState":"allow","startExperimentRun":"allow"}' NOT NULL;
