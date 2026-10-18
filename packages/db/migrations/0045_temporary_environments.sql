ALTER TABLE environments ADD COLUMN expires_at TEXT;
--> statement-breakpoint
ALTER TABLE environments ADD COLUMN synced_from_environment_id TEXT;
--> statement-breakpoint
ALTER TABLE environments ADD COLUMN synced_at TEXT CHECK (
  (expires_at IS NULL AND synced_from_environment_id IS NULL AND synced_at IS NULL)
  OR (expires_at IS NOT NULL AND synced_from_environment_id IS NOT NULL AND synced_at IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX environments_expires_at_idx ON environments(expires_at);
--> statement-breakpoint
ALTER TABLE flag_change_events ADD COLUMN temporary_environment INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Capture kind while the Environment still exists, including configuration removals.
CREATE TRIGGER flag_change_events_environment_kind AFTER INSERT ON flag_change_events
WHEN NEW.environment_id IS NOT NULL
BEGIN
  UPDATE flag_change_events SET temporary_environment = EXISTS (
    SELECT 1 FROM environments
    WHERE id = NEW.environment_id AND app_id = NEW.app_id AND expires_at IS NOT NULL
  ) WHERE seq = NEW.seq;
END;
