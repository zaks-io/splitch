CREATE TABLE `device_refresh_sessions` (
	`refresh_token_hash` text PRIMARY KEY NOT NULL,
	`provider_session_id` text NOT NULL,
	`created_at` text NOT NULL
);
