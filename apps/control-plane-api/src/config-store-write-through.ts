import type { ControlPlaneFlagConfigSnapshot } from "./config-store-kv";

const WRITE_THROUGH_MAX_ENTRIES = 128;
const WRITE_THROUGH_TTL_MS = 60_000;
const expirationsByStore = new WeakMap<
  Map<string, ControlPlaneFlagConfigSnapshot>,
  Map<string, number>
>();

export interface ConfigStoreWriteThrough {
  delete(key: string): void;
  get(key: string): ControlPlaneFlagConfigSnapshot | undefined;
  set(key: string, snapshot: ControlPlaneFlagConfigSnapshot): void;
}

export function configStoreWriteThrough(
  entries: Map<string, ControlPlaneFlagConfigSnapshot>,
  options: { maxEntries?: number; now?: () => number; ttlMs?: number } = {},
): ConfigStoreWriteThrough {
  const maxEntries = options.maxEntries ?? WRITE_THROUGH_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? WRITE_THROUGH_TTL_MS;
  if (maxEntries < 1 || ttlMs < 1) {
    throw new Error("config-store: write-through bounds must be positive");
  }
  const expirations = expirationsFor(entries);

  return {
    delete(key) {
      entries.delete(key);
      expirations.delete(key);
    },
    get(key) {
      const expiresAt = expirations.get(key);
      if (expiresAt === undefined || expiresAt <= now()) {
        entries.delete(key);
        expirations.delete(key);
        return undefined;
      }
      const snapshot = entries.get(key);
      if (!snapshot) {
        expirations.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, snapshot);
      return snapshot;
    },
    set(key, snapshot) {
      const currentTime = now();
      pruneExpired(entries, expirations, currentTime);
      if (entries.has(key)) entries.delete(key);
      while (entries.size >= maxEntries) {
        evictOldest(entries, expirations);
      }
      entries.set(key, snapshot);
      expirations.set(key, currentTime + ttlMs);
    },
  };
}

function pruneExpired(
  entries: Map<string, ControlPlaneFlagConfigSnapshot>,
  expirations: Map<string, number>,
  now: number,
): void {
  for (const [key, expiresAt] of expirations) {
    if (expiresAt > now) continue;
    expirations.delete(key);
    entries.delete(key);
  }
}

function evictOldest(
  entries: Map<string, ControlPlaneFlagConfigSnapshot>,
  expirations: Map<string, number>,
): void {
  const oldestKey = entries.keys().next().value;
  if (oldestKey === undefined) return;
  entries.delete(oldestKey);
  expirations.delete(oldestKey);
}

function expirationsFor(entries: Map<string, ControlPlaneFlagConfigSnapshot>): Map<string, number> {
  let expirations = expirationsByStore.get(entries);
  if (!expirations) {
    expirations = new Map();
    expirationsByStore.set(entries, expirations);
  }
  return expirations;
}
