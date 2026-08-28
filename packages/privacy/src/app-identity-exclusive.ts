/**
 * Serialization primitives for App identity provision. In-process exclusive
 * covers one isolate; Durable Object put-if-absent covers Evaluation and
 * Event Ingest racing on the same App.
 */

export interface AppIdentityKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface AppIdentityExclusive {
  runExclusive<T>(appId: string, fn: () => Promise<T>): Promise<T>;
}

export function makeInProcessAppIdentityExclusive(): AppIdentityExclusive {
  const locks = new Map<string, Promise<void>>();
  return {
    async runExclusive(appId, fn) {
      const previous = locks.get(appId) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queued = previous.then(() => next);
      locks.set(appId, queued);
      await previous;
      try {
        return await fn();
      } finally {
        release();
        if (locks.get(appId) === queued) {
          locks.delete(appId);
        }
      }
    },
  };
}

function appIdentityCoordinatorName(appId: string): string {
  return `app-identity:${appId}`;
}

function isAppEntityIdentityRecordKey(recordKey: string): boolean {
  return /^app:[^:]+:entity-identity$/u.test(recordKey);
}

export async function putWrappedAppIdentityIfAbsent(
  kv: AppIdentityKv,
  recordKey: string,
  value: string,
): Promise<string> {
  if (!isAppEntityIdentityRecordKey(recordKey)) {
    throw new Error("privacy: invalid App identity record key");
  }
  const existing = await kv.get(recordKey);
  if (existing !== null) {
    return existing;
  }
  await kv.put(recordKey, value);
  return value;
}

export function makeDurableAppIdentityPutIfAbsent(namespace: {
  getByName(name: string): {
    putAppIdentityIfAbsent(recordKey: string, value: string): Promise<string>;
  };
}): (recordKey: string, value: string) => Promise<string> {
  return (recordKey, value) => {
    if (!isAppEntityIdentityRecordKey(recordKey)) {
      throw new Error("privacy: invalid App identity record key");
    }
    const appId = recordKey.slice("app:".length, -":entity-identity".length);
    return namespace
      .getByName(appIdentityCoordinatorName(appId))
      .putAppIdentityIfAbsent(recordKey, value);
  };
}
