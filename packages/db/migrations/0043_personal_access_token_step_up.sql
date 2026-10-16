CREATE TABLE personal_access_token_step_up_uses (
  jti TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX personal_access_token_step_up_uses_retention_idx
  ON personal_access_token_step_up_uses (expires_at, jti);

CREATE TABLE personal_access_token_rotations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  token_id TEXT NOT NULL REFERENCES personal_access_tokens(id) ON DELETE CASCADE,
  previous_hash TEXT NOT NULL,
  candidate_hash TEXT NOT NULL,
  operation_hash TEXT NOT NULL,
  step_up_jti TEXT REFERENCES personal_access_token_step_up_uses(jti),
  phase TEXT NOT NULL CHECK (phase IN ('claimed', 'old_tombstoned', 'candidate_published', 'swapped', 'completed', 'retiring', 'retired')),
  claimed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX personal_access_token_rotations_exclusive_idx
  ON personal_access_token_rotations (token_id) WHERE phase NOT IN ('completed', 'retired');
CREATE INDEX personal_access_token_rotations_pending_idx
  ON personal_access_token_rotations (phase, updated_at);
