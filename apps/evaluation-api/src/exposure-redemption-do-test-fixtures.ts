import type { ExposureRedemptionClaimDoContext } from "./exposure-redemption-do-handler";
import { runExposureRedemptionClaimAlarm } from "./exposure-redemption-do-handler";

type ClaimListCall = {
  limit?: number;
  startAfter?: string;
  size: number;
  keys: string[];
};

export type ClaimMemoryCtx = ExposureRedemptionClaimDoContext & {
  listCalls: ClaimListCall[];
};

/** In-memory DO storage with byte-order list (matches real DO / startAfter). */
export function claimMemoryCtx(): ClaimMemoryCtx {
  const map = new Map<string, unknown>();
  let alarm: number | null = null;
  const listCalls: ClaimListCall[] = [];
  const storage = {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    delete: async (key: string | string[]) => {
      if (Array.isArray(key)) for (const k of key) map.delete(k);
      else map.delete(key);
    },
    list: async <T>(options?: { limit?: number; startAfter?: string }) => {
      // Byte order (code-unit), matching real DO storage — not localeCompare.
      let entries = Array.from(map.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (options?.startAfter !== undefined) {
        const after = options.startAfter;
        entries = entries.filter(([key]) => key > after);
      }
      if (options?.limit !== undefined) entries = entries.slice(0, options.limit);
      listCalls.push({
        limit: options?.limit,
        startAfter: options?.startAfter,
        size: entries.length,
        keys: entries.map(([key]) => key),
      });
      return new Map(entries as Array<[string, T]>);
    },
    getAlarm: async () => alarm,
    setAlarm: async (scheduledTime: number) => {
      alarm = scheduledTime;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
    transaction: async <T>(fn: (txn: DurableObjectTransaction) => Promise<T>) =>
      fn(storage as unknown as DurableObjectTransaction),
  } as unknown as DurableObjectStorage;
  return {
    listCalls,
    storage,
  };
}

/** workerd clears the scheduled alarm before invoking `alarm()`. */
export async function simulateClaimAlarm(ctx: ClaimMemoryCtx): Promise<void> {
  await ctx.storage.deleteAlarm();
  await runExposureRedemptionClaimAlarm(ctx.storage);
}

export function claimPost(path: string, body: unknown): Request {
  return new Request(`https://exposure-redemption-claim.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function putSealedExposure(
  ctx: ExposureRedemptionClaimDoContext,
  exposureId: string,
  expiresAt: number,
): Promise<void> {
  await ctx.storage.put(`exposure:${exposureId}`, {
    ticketFingerprint: `fp-${exposureId}`,
    delivery: "sealed",
    expiresAt,
  });
}
