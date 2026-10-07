ALTER TABLE convex_installations ADD preparation_retry_at TEXT;
--> statement-breakpoint
CREATE INDEX config_webhook_delivery_installation_lease_idx
  ON config_webhook_deliveries (installation_id, state, lease_expires_at);

CREATE INDEX cloudflare_config_delivery_app_due_idx
  ON cloudflare_config_deliveries (app_id, state, next_attempt_at, lease_expires_at);

--> statement-breakpoint
CREATE INDEX config_webhook_delivery_outstanding_idx
  ON config_webhook_deliveries (installation_id, environment_version)
  WHERE state IN ('pending', 'leased');
--> statement-breakpoint
CREATE INDEX convex_installations_preparation_due_idx
  ON convex_installations (status, preparation_retry_at);
