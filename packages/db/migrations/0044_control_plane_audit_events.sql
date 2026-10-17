-- No foreign keys: the security record must outlive its subject.
CREATE TABLE control_plane_audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  app_id TEXT NOT NULL,
  environment_id TEXT,
  organization_id TEXT NOT NULL,
  actor_ref TEXT,
  actor_via TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  target_version TEXT,
  outcome TEXT NOT NULL,
  request_id TEXT,
  approval_request_id TEXT,
  run_id TEXT,
  changes_json TEXT NOT NULL CHECK (json_valid(changes_json)),
  changed_at TEXT NOT NULL,
  forwarded_at TEXT
);
--> statement-breakpoint
CREATE INDEX control_plane_audit_events_pending_idx ON control_plane_audit_events(forwarded_at, seq);
--> statement-breakpoint
CREATE INDEX control_plane_audit_events_app_seq_idx ON control_plane_audit_events(app_id, seq);
--> statement-breakpoint
CREATE INDEX control_plane_audit_events_retention_idx ON control_plane_audit_events(changed_at) WHERE forwarded_at IS NOT NULL;
