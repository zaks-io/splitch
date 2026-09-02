interface AppIdentityLeaseResponse {
  readonly value: string | null;
  readonly expiresAt: number;
}

export interface AppIdentityCoordinatorNamespace {
  getByName(name: string): {
    readAppIdentity?(
      appId: string,
      options?: { readonly lease: true },
    ): Promise<string | null | AppIdentityLeaseResponse>;
    putAppIdentityIfAbsent?(appId: string, value: string): Promise<string>;
  };
}

interface AppIdentityLease {
  readonly value: string | null;
  /** Null is a pre-lease server response and is never retained after this read. */
  readonly expiresAt: number | null;
}

type CachedAppIdentityLease =
  | { readonly found: true; readonly value: string | null }
  | { readonly found: false };

const durableIdentityLeases = new WeakMap<
  AppIdentityCoordinatorNamespace,
  Map<string, Promise<AppIdentityLease>>
>();

export function makeAppIdentityCoordinator(namespace: AppIdentityCoordinatorNamespace) {
  const leases = durableIdentityLeaseCache(namespace);
  return {
    load: (appId: string) => loadDurableAppIdentity(namespace, leases, appId),
    async putIfAbsent(appId: string, value: string) {
      const winner = await coordinatorFor(namespace, appId).putAppIdentityIfAbsent(appId, value);
      leases.delete(appId);
      return winner;
    },
  };
}

async function loadDurableAppIdentity(
  namespace: AppIdentityCoordinatorNamespace,
  leases: Map<string, Promise<AppIdentityLease>>,
  appId: string,
): Promise<string | null> {
  const existing = leases.get(appId);
  if (existing !== undefined) {
    const cached = await reusableAppIdentityLease(leases, appId, existing);
    if (cached.found) return cached.value;
  }

  const coordinator = coordinatorFor(namespace, appId);
  const pending = coordinator
    .readAppIdentity(appId, { lease: true })
    .then(normalizeAppIdentityLease);
  leases.set(appId, pending);
  let leased: AppIdentityLease;
  try {
    leased = await pending;
  } catch (error) {
    deletePendingAppIdentityLease(leases, appId, pending);
    throw error;
  }
  if (leased.expiresAt === null) {
    deletePendingAppIdentityLease(leases, appId, pending);
    return leased.value;
  }
  if (!Number.isFinite(leased.expiresAt) || leased.expiresAt <= Date.now()) {
    deletePendingAppIdentityLease(leases, appId, pending);
    throw new Error("privacy: App identity coordinator returned an invalid lease");
  }
  return leased.value;
}

async function reusableAppIdentityLease(
  leases: Map<string, Promise<AppIdentityLease>>,
  appId: string,
  pending: Promise<AppIdentityLease>,
): Promise<CachedAppIdentityLease> {
  const leased = await pending;
  if (leased.expiresAt === null) {
    deletePendingAppIdentityLease(leases, appId, pending);
    return { found: true, value: leased.value };
  }
  if (leased.expiresAt > Date.now()) return { found: true, value: leased.value };
  const replacement = leases.get(appId);
  if (replacement !== pending && replacement !== undefined) {
    return reusableAppIdentityLease(leases, appId, replacement);
  }
  leases.delete(appId);
  return { found: false };
}

function deletePendingAppIdentityLease(
  leases: Map<string, Promise<AppIdentityLease>>,
  appId: string,
  pending: Promise<AppIdentityLease>,
): void {
  if (leases.get(appId) === pending) leases.delete(appId);
}

function durableIdentityLeaseCache(
  namespace: AppIdentityCoordinatorNamespace,
): Map<string, Promise<AppIdentityLease>> {
  const existing = durableIdentityLeases.get(namespace);
  if (existing !== undefined) return existing;
  const created = new Map<string, Promise<AppIdentityLease>>();
  durableIdentityLeases.set(namespace, created);
  return created;
}

function normalizeAppIdentityLease(
  value: string | null | AppIdentityLeaseResponse,
): AppIdentityLease {
  if (typeof value === "string" || value === null) return { value, expiresAt: null };
  if (
    typeof value === "object" &&
    (typeof value.value === "string" || value.value === null) &&
    typeof value.expiresAt === "number"
  ) {
    return value;
  }
  throw new Error("privacy: App identity coordinator returned an invalid lease");
}

function coordinatorFor(namespace: AppIdentityCoordinatorNamespace, appId: string) {
  const stub = namespace.getByName(`app-identity:${appId}`);
  if (
    typeof stub.readAppIdentity !== "function" ||
    typeof stub.putAppIdentityIfAbsent !== "function"
  ) {
    throw new Error("privacy: App identity coordinator is unavailable");
  }
  return {
    readAppIdentity: stub.readAppIdentity.bind(stub),
    putAppIdentityIfAbsent: stub.putAppIdentityIfAbsent.bind(stub),
  };
}
