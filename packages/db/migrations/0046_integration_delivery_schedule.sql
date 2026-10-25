CREATE INDEX cloudflare_config_delivery_outstanding_idx
  ON cloudflare_config_deliveries (installation_id, environment_version)
  WHERE state IN ('pending', 'leased');


CREATE INDEX cloudflare_config_delivery_env_due_idx
  ON cloudflare_config_deliveries (app_id, environment_id, state, next_attempt_at, lease_expires_at);
CREATE INDEX cloudflare_config_delivery_env_expiry_idx
  ON cloudflare_config_deliveries (app_id, environment_id, state, lease_expires_at);
CREATE INDEX config_webhook_delivery_owner_idx
  ON config_webhook_deliveries (lease_owner) WHERE state = 'leased';
CREATE INDEX cloudflare_config_delivery_owner_idx
  ON cloudflare_config_deliveries (lease_owner) WHERE state = 'leased';
