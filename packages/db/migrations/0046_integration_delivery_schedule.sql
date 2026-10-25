CREATE INDEX cloudflare_config_delivery_outstanding_idx
  ON cloudflare_config_deliveries (installation_id, environment_version)
  WHERE state IN ('pending', 'leased');
