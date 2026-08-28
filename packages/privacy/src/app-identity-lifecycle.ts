/**
 * ADR-0044 compromised-key lifecycle. Activation of a replacement epoch is
 * forbidden until every durable purge checkpoint is recorded. Evaluation and
 * Event Ingest fail closed while the App is not `active`.
 */

const APP_IDENTITY_LIFECYCLE_STATES = ["active", "blocked", "purging", "activating"] as const;

type AppIdentityLifecycleState = (typeof APP_IDENTITY_LIFECYCLE_STATES)[number];

const APP_IDENTITY_PURGE_SURFACES = [
  "assignments",
  "analytics",
  "idempotency",
  "export",
  "deletion",
] as const;

interface AppIdentityPurgeCheckpoints {
  readonly assignments: boolean;
  readonly analytics: boolean;
  readonly idempotency: boolean;
  readonly export: boolean;
  readonly deletion: boolean;
}

export interface AppIdentityLifecycle {
  readonly state: AppIdentityLifecycleState;
  readonly trafficBlocked: boolean;
  readonly runsEnded: boolean;
  readonly clientKeysRevoked: boolean;
  readonly purge: AppIdentityPurgeCheckpoints;
}

const EMPTY_PURGE_CHECKPOINTS: AppIdentityPurgeCheckpoints = {
  assignments: false,
  analytics: false,
  idempotency: false,
  export: false,
  deletion: false,
};

export const ACTIVE_APP_IDENTITY_LIFECYCLE: AppIdentityLifecycle = {
  state: "active",
  trafficBlocked: false,
  runsEnded: false,
  clientKeysRevoked: false,
  purge: EMPTY_PURGE_CHECKPOINTS,
};

function isAppIdentityLifecycleState(value: unknown): value is AppIdentityLifecycleState {
  return (
    typeof value === "string" &&
    (APP_IDENTITY_LIFECYCLE_STATES as readonly string[]).includes(value)
  );
}

export function parseAppIdentityLifecycle(value: unknown): AppIdentityLifecycle {
  if (value === undefined) return ACTIVE_APP_IDENTITY_LIFECYCLE;
  if (typeof value !== "object" || value === null) {
    throw new Error("privacy: ambiguous App identity lifecycle");
  }
  const raw = value as Record<string, unknown>;
  if (!isAppIdentityLifecycleState(raw.state)) {
    throw new Error("privacy: ambiguous App identity lifecycle state");
  }
  if (typeof raw.trafficBlocked !== "boolean") {
    throw new Error("privacy: ambiguous App identity traffic block");
  }
  if (typeof raw.runsEnded !== "boolean" || typeof raw.clientKeysRevoked !== "boolean") {
    throw new Error("privacy: ambiguous App identity rotation checkpoints");
  }
  return {
    state: raw.state,
    trafficBlocked: raw.trafficBlocked,
    runsEnded: raw.runsEnded,
    clientKeysRevoked: raw.clientKeysRevoked,
    purge: parsePurgeCheckpoints(raw.purge),
  };
}

export function assertAppIdentityTrafficAllowed(lifecycle: AppIdentityLifecycle): void {
  if (lifecycle.state !== "active" || lifecycle.trafficBlocked) {
    throw new Error("privacy: App identity traffic is blocked");
  }
}

export function beginCompromisedAppIdentityLifecycle(): AppIdentityLifecycle {
  return {
    state: "blocked",
    trafficBlocked: true,
    runsEnded: false,
    clientKeysRevoked: false,
    purge: EMPTY_PURGE_CHECKPOINTS,
  };
}

export function withAppIdentityLifecycleCheckpoint(
  current: AppIdentityLifecycle,
  checkpoint: AppIdentityLifecycleCheckpoint,
): AppIdentityLifecycle {
  if (current.state === "active" && !current.trafficBlocked) {
    throw new Error("privacy: cannot checkpoint an active App identity");
  }
  const next: AppIdentityLifecycle = {
    state: "purging",
    trafficBlocked: true,
    runsEnded: checkpoint.runsEnded === true ? true : current.runsEnded,
    clientKeysRevoked: checkpoint.clientKeysRevoked === true ? true : current.clientKeysRevoked,
    purge: {
      assignments: checkpoint.purge?.assignments === true ? true : current.purge.assignments,
      analytics: checkpoint.purge?.analytics === true ? true : current.purge.analytics,
      idempotency: checkpoint.purge?.idempotency === true ? true : current.purge.idempotency,
      export: checkpoint.purge?.export === true ? true : current.purge.export,
      deletion: checkpoint.purge?.deletion === true ? true : current.purge.deletion,
    },
  };
  return next;
}

export function assertAppIdentityActivationAllowed(lifecycle: AppIdentityLifecycle): void {
  if (!lifecycle.trafficBlocked) {
    throw new Error("privacy: compromised rotation must block traffic before activation");
  }
  if (!lifecycle.runsEnded) {
    throw new Error("privacy: cannot activate before active Runs are ended");
  }
  if (!lifecycle.clientKeysRevoked) {
    throw new Error("privacy: cannot activate before Client Keys are revoked");
  }
  for (const surface of APP_IDENTITY_PURGE_SURFACES) {
    if (!lifecycle.purge[surface]) {
      throw new Error(`privacy: cannot activate before ${surface} purge checkpoint`);
    }
  }
}

export interface AppIdentityLifecycleCheckpoint {
  readonly runsEnded?: boolean;
  readonly clientKeysRevoked?: boolean;
  readonly purge?: Partial<AppIdentityPurgeCheckpoints>;
}

function parsePurgeCheckpoints(value: unknown): AppIdentityPurgeCheckpoints {
  if (typeof value !== "object" || value === null) {
    throw new Error("privacy: ambiguous App identity purge checkpoints");
  }
  const raw = value as Record<string, unknown>;
  const purge = { ...EMPTY_PURGE_CHECKPOINTS };
  for (const surface of APP_IDENTITY_PURGE_SURFACES) {
    if (typeof raw[surface] !== "boolean") {
      throw new Error(`privacy: ambiguous ${surface} purge checkpoint`);
    }
    purge[surface] = raw[surface];
  }
  return purge;
}
