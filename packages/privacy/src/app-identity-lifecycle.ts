/** Durable progress for the destructive ADR-0044 compromised-key reset. */

export const APP_IDENTITY_RESET_STORES = [
  "runs_and_credentials",
  "delivery",
  "assignments",
  "analytics",
  "retry_claims",
  "entity_deletions",
  "privacy_subject_refs",
] as const;

export const APP_IDENTITY_RESET_RELEASES = ["evaluation", "event_ingest"] as const;

export type AppIdentityResetStore = (typeof APP_IDENTITY_RESET_STORES)[number];
export type AppIdentityResetProofs = Record<AppIdentityResetStore, string | null>;
export type AppIdentityResetRelease = (typeof APP_IDENTITY_RESET_RELEASES)[number];
export type AppIdentityResetReleaseProofs = Record<AppIdentityResetRelease, string | null>;

export interface AppIdentityLifecycle {
  readonly state: "active" | "blocked" | "purging" | "activation_pending";
  readonly trafficBlocked: boolean;
  readonly resetId: string | null;
  readonly proofs: AppIdentityResetProofs;
  readonly releaseProofs: AppIdentityResetReleaseProofs;
}

const EMPTY_APP_IDENTITY_RESET_PROOFS: AppIdentityResetProofs = {
  runs_and_credentials: null,
  delivery: null,
  assignments: null,
  analytics: null,
  retry_claims: null,
  entity_deletions: null,
  privacy_subject_refs: null,
};

const EMPTY_APP_IDENTITY_RESET_RELEASE_PROOFS: AppIdentityResetReleaseProofs = {
  evaluation: null,
  event_ingest: null,
};

export const ACTIVE_APP_IDENTITY_LIFECYCLE: AppIdentityLifecycle = {
  state: "active",
  trafficBlocked: false,
  resetId: null,
  proofs: EMPTY_APP_IDENTITY_RESET_PROOFS,
  releaseProofs: EMPTY_APP_IDENTITY_RESET_RELEASE_PROOFS,
};

export function blockedAppIdentityLifecycle(resetId: string): AppIdentityLifecycle {
  if (resetId.trim().length === 0) throw new Error("privacy: App identity resetId is empty");
  return {
    state: "blocked",
    trafficBlocked: true,
    resetId,
    proofs: { ...EMPTY_APP_IDENTITY_RESET_PROOFS },
    releaseProofs: { ...EMPTY_APP_IDENTITY_RESET_RELEASE_PROOFS },
  };
}

export function withAppIdentityResetProof(
  lifecycle: AppIdentityLifecycle,
  store: AppIdentityResetStore,
  proof: string,
): AppIdentityLifecycle {
  if (!lifecycle.trafficBlocked || lifecycle.state === "active") {
    throw new Error("privacy: cannot record reset proof before traffic is blocked");
  }
  if (proof.trim().length === 0) {
    throw new Error(`privacy: ${store} reset proof is empty`);
  }
  return {
    state: "purging",
    trafficBlocked: true,
    resetId: lifecycle.resetId,
    proofs: { ...lifecycle.proofs, [store]: proof },
    releaseProofs: lifecycle.releaseProofs,
  };
}

export function activationPendingAppIdentityLifecycle(
  lifecycle: AppIdentityLifecycle,
): AppIdentityLifecycle {
  assertAppIdentityResetProved(lifecycle);
  return {
    state: "activation_pending",
    trafficBlocked: true,
    resetId: lifecycle.resetId,
    proofs: lifecycle.proofs,
    releaseProofs: lifecycle.releaseProofs,
  };
}

export function withAppIdentityResetReleaseProof(
  lifecycle: AppIdentityLifecycle,
  release: AppIdentityResetRelease,
  proof: string,
): AppIdentityLifecycle {
  if (lifecycle.state !== "activation_pending" || !lifecycle.trafficBlocked) {
    throw new Error("privacy: cannot record reset release before activation is pending");
  }
  if (proof.trim().length === 0) {
    throw new Error(`privacy: ${release} reset release proof is empty`);
  }
  return {
    ...lifecycle,
    releaseProofs: { ...lifecycle.releaseProofs, [release]: proof },
  };
}

export function activeAppIdentityLifecycle(lifecycle: AppIdentityLifecycle): AppIdentityLifecycle {
  assertAppIdentityResetReleased(lifecycle);
  return { ...lifecycle, state: "active", trafficBlocked: false };
}

export function assertAppIdentityResetProved(lifecycle: AppIdentityLifecycle): void {
  for (const store of APP_IDENTITY_RESET_STORES) {
    if (lifecycle.proofs[store] === null) {
      throw new Error(`privacy: cannot activate before ${store} purge proof`);
    }
  }
}

function assertAppIdentityResetReleased(lifecycle: AppIdentityLifecycle): void {
  for (const release of APP_IDENTITY_RESET_RELEASES) {
    if (lifecycle.releaseProofs[release] === null) {
      throw new Error(`privacy: cannot activate before ${release} release proof`);
    }
  }
}

export function parseAppIdentityLifecycle(value: unknown): AppIdentityLifecycle {
  if (typeof value !== "object" || value === null) {
    throw new Error("privacy: ambiguous App identity lifecycle");
  }
  const raw = value as Record<string, unknown>;
  assertExactKeys(raw, ["state", "trafficBlocked", "resetId", "proofs", "releaseProofs"]);
  const header = parseLifecycleHeader(raw);
  return {
    ...header,
    proofs: parseProofs(raw.proofs),
    releaseProofs: parseReleaseProofs(raw.releaseProofs),
  };
}

function parseLifecycleHeader(
  raw: Record<string, unknown>,
): Omit<AppIdentityLifecycle, "proofs" | "releaseProofs"> {
  if (
    raw.state !== "active" &&
    raw.state !== "blocked" &&
    raw.state !== "purging" &&
    raw.state !== "activation_pending"
  ) {
    throw new Error("privacy: ambiguous App identity lifecycle state");
  }
  if (typeof raw.trafficBlocked !== "boolean") {
    throw new Error("privacy: ambiguous App identity traffic block");
  }
  if (raw.state === "active" ? raw.trafficBlocked : !raw.trafficBlocked) {
    throw new Error("privacy: inconsistent App identity traffic block");
  }
  if (
    raw.resetId !== null &&
    (typeof raw.resetId !== "string" || raw.resetId.trim().length === 0)
  ) {
    throw new Error("privacy: ambiguous App identity resetId");
  }
  return {
    state: raw.state,
    trafficBlocked: raw.trafficBlocked,
    resetId: raw.resetId as string | null,
  };
}

function parseReleaseProofs(value: unknown): AppIdentityResetReleaseProofs {
  if (typeof value !== "object" || value === null) {
    throw new Error("privacy: ambiguous App identity reset release proofs");
  }
  const raw = value as Record<string, unknown>;
  assertExactKeys(raw, APP_IDENTITY_RESET_RELEASES);
  const proofs = { ...EMPTY_APP_IDENTITY_RESET_RELEASE_PROOFS };
  for (const release of APP_IDENTITY_RESET_RELEASES) {
    const proof = raw[release];
    if (proof !== null && (typeof proof !== "string" || proof.trim().length === 0)) {
      throw new Error(`privacy: ambiguous ${release} reset release proof`);
    }
    proofs[release] = proof as string | null;
  }
  return proofs;
}

export function assertAppIdentityTrafficAllowed(lifecycle: AppIdentityLifecycle): void {
  if (lifecycle.state !== "active" || lifecycle.trafficBlocked) {
    throw new Error("privacy: App identity traffic is blocked");
  }
}

function parseProofs(value: unknown): AppIdentityResetProofs {
  if (typeof value !== "object" || value === null) {
    throw new Error("privacy: ambiguous App identity reset proofs");
  }
  const raw = value as Record<string, unknown>;
  assertExactKeys(raw, APP_IDENTITY_RESET_STORES);
  const proofs = { ...EMPTY_APP_IDENTITY_RESET_PROOFS };
  for (const store of APP_IDENTITY_RESET_STORES) {
    const proof = raw[store];
    if (proof !== null && (typeof proof !== "string" || proof.trim().length === 0)) {
      throw new Error(`privacy: ambiguous ${store} reset proof`);
    }
    proofs[store] = proof as string | null;
  }
  return proofs;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error("privacy: App identity lifecycle contains unknown or missing fields");
  }
}
