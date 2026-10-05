ALTER TABLE `config_webhook_deliveries` ADD `completed_at` text;
--> statement-breakpoint
ALTER TABLE `cloudflare_config_deliveries` ADD `completed_at` text;
--> statement-breakpoint

-- Legacy failures have no trustworthy completion time. Give them a full retention
-- window after migration rather than aging them from the original config commit.
UPDATE `config_webhook_deliveries`
SET `completed_at` = CASE
  WHEN `state` = 'delivered' AND `delivered_at` IS NOT NULL THEN `delivered_at`
  ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
WHERE `state` IN ('delivered', 'terminal', 'suppressed');
--> statement-breakpoint
UPDATE `cloudflare_config_deliveries`
SET `completed_at` = CASE
  WHEN `state` = 'delivered' AND `delivered_at` IS NOT NULL THEN `delivered_at`
  ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
WHERE `state` IN ('delivered', 'terminal', 'suppressed');
--> statement-breakpoint

CREATE INDEX `config_webhook_delivery_completed_idx`
ON `config_webhook_deliveries` (`completed_at`)
WHERE `state` IN ('delivered', 'terminal', 'suppressed');
--> statement-breakpoint
CREATE INDEX `cloudflare_config_delivery_completed_idx`
ON `cloudflare_config_deliveries` (`completed_at`)
WHERE `state` IN ('delivered', 'terminal', 'suppressed');
--> statement-breakpoint

-- State triggers also cover suppression by config-commit and App-deletion writers.
CREATE TRIGGER `config_webhook_delivery_completion_after_insert`
AFTER INSERT ON `config_webhook_deliveries`
WHEN NEW.`state` IN ('delivered', 'terminal', 'suppressed')
BEGIN
  UPDATE `config_webhook_deliveries` SET `completed_at` = CASE
    WHEN NEW.`state` = 'delivered' THEN coalesce(NEW.`delivered_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHEN NEW.`state` IN ('terminal', 'suppressed') THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ELSE NULL END
  WHERE `delivery_id` = NEW.`delivery_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `config_webhook_delivery_completion_after_state_update`
AFTER UPDATE OF `state` ON `config_webhook_deliveries`
WHEN OLD.`state` IS NOT NEW.`state`
  AND (OLD.`state` IN ('delivered', 'terminal', 'suppressed')
    OR NEW.`state` IN ('delivered', 'terminal', 'suppressed'))
BEGIN
  UPDATE `config_webhook_deliveries` SET `completed_at` = CASE
    WHEN NEW.`state` = 'delivered' THEN coalesce(NEW.`delivered_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHEN NEW.`state` IN ('terminal', 'suppressed') THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ELSE NULL END
  WHERE `delivery_id` = NEW.`delivery_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `cloudflare_config_delivery_completion_after_insert`
AFTER INSERT ON `cloudflare_config_deliveries`
WHEN NEW.`state` IN ('delivered', 'terminal', 'suppressed')
BEGIN
  UPDATE `cloudflare_config_deliveries` SET `completed_at` = CASE
    WHEN NEW.`state` = 'delivered' THEN coalesce(NEW.`delivered_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHEN NEW.`state` IN ('terminal', 'suppressed') THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ELSE NULL END
  WHERE `delivery_id` = NEW.`delivery_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `cloudflare_config_delivery_completion_after_state_update`
AFTER UPDATE OF `state` ON `cloudflare_config_deliveries`
WHEN OLD.`state` IS NOT NEW.`state`
  AND (OLD.`state` IN ('delivered', 'terminal', 'suppressed')
    OR NEW.`state` IN ('delivered', 'terminal', 'suppressed'))
BEGIN
  UPDATE `cloudflare_config_deliveries` SET `completed_at` = CASE
    WHEN NEW.`state` = 'delivered' THEN coalesce(NEW.`delivered_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHEN NEW.`state` IN ('terminal', 'suppressed') THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ELSE NULL END
  WHERE `delivery_id` = NEW.`delivery_id`;
END;
