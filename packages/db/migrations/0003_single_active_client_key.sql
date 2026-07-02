CREATE UNIQUE INDEX `client_keys_active_env_unique` ON `client_keys` (`app_id`,`environment_id`) WHERE revoked_at IS NULL;
