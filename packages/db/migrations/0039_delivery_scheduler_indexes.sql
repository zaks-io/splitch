CREATE INDEX `config_webhook_delivery_expiry_idx`
  ON `config_webhook_deliveries` (`state`, `lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `cloudflare_config_delivery_expiry_idx`
  ON `cloudflare_config_deliveries` (`state`, `lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `flag_change_events_app_seq_idx`
  ON `flag_change_events` (`app_id`, `seq`);
