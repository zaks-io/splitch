import {
  applyExposureRedemptionAcknowledge,
  applyExposureRedemptionClaim,
  applyExposureRedemptionMarkSealed,
  applyExposureRedemptionRelease,
  type ExposureBindingRecord,
  type ExposureRedemptionClaimStorage,
  type TicketBindingRecord,
} from "./exposure-redemption-claim-core";

const EXPOSURE_KEY_PREFIX = "exposure:";
const TICKET_KEY_PREFIX = "ticket:";
/** Cursor for multi-tick GC; sorts before claim keys and is skipped in expiry. */
const SWEEP_CURSOR_KEY = "__sweep_after";

/**
 * Max keys listed per alarm tick. DO alarms share isolate CPU with fetch;
 * 256 keeps a tick small (deserialize + delete) while large keyspaces drain
 * via immediate re-arm when a full page returns.
 */
export const EXPOSURE_REDEMPTION_SWEEP_PAGE_SIZE = 256;

type SweepCursor = {
  readonly after: string;
  readonly nextExpiry: number | null;
};

/** Minimal DO context the claim handler needs — keeps tests free of cloudflare:workers. */
export interface ExposureRedemptionClaimDoContext {
  readonly storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

type ClaimBody = {
  exposureId: string;
  ticketFingerprint: string;
  nowMs: number;
};

/**
 * Request handler for ExposureRedemptionClaimDurableObject. Extracted so unit
 * and Miniflare tests exercise the real routes. Mutations never throw inside
 * `blockConcurrencyWhile` — workerd aborts the DO on throw across that boundary,
 * which would kill every concurrent claim for the App+Environment.
 */
export async function handleExposureRedemptionClaimFetch(
  ctx: ExposureRedemptionClaimDoContext,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const body = await parseClaimBody(request);
  if (body === null) {
    return Response.json({ error: "invalid claim payload" }, { status: 400 });
  }
  const path = new URL(request.url).pathname;
  const storage = new DurableClaimStorage(ctx.storage);
  const args = {
    exposureId: body.exposureId,
    ticketFingerprint: body.ticketFingerprint,
    nowMs: body.nowMs,
  };
  return dispatchClaimRoute(ctx, storage, path, args);
}

async function dispatchClaimRoute(
  ctx: ExposureRedemptionClaimDoContext,
  storage: DurableClaimStorage,
  path: string,
  args: { exposureId: string; ticketFingerprint: string; nowMs: number },
): Promise<Response> {
  if (path === "/claim") {
    return Response.json(
      await ctx.blockConcurrencyWhile(() => applyExposureRedemptionClaim(storage, args)),
    );
  }
  if (path === "/release") {
    await ctx.blockConcurrencyWhile(() => applyExposureRedemptionRelease(storage, args));
    return Response.json({ ok: true });
  }
  if (path === "/markSealed") {
    const result = await ctx.blockConcurrencyWhile(() =>
      applyExposureRedemptionMarkSealed(storage, args),
    );
    return result.ok
      ? Response.json({ ok: true })
      : Response.json({ error: result.error }, { status: 409 });
  }
  if (path === "/acknowledge") {
    const result = await ctx.blockConcurrencyWhile(() =>
      applyExposureRedemptionAcknowledge(storage, args),
    );
    return result.ok
      ? Response.json(result.value)
      : Response.json({ error: result.error }, { status: 409 });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

export async function runExposureRedemptionClaimAlarm(
  storageApi: DurableObjectStorage,
): Promise<void> {
  const storage = new DurableClaimStorage(storageApi);
  const nextExpiry = await storage.deleteExpired(Date.now());
  if (nextExpiry !== null) {
    await storage.setExpiryAlarm(nextExpiry);
    return;
  }
  await storageApi.deleteAlarm();
}

class DurableClaimStorage implements ExposureRedemptionClaimStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  async getExposure(exposureId: string): Promise<ExposureBindingRecord | undefined> {
    return this.storage.get<ExposureBindingRecord>(`${EXPOSURE_KEY_PREFIX}${exposureId}`);
  }

  async getTicket(ticketFingerprint: string): Promise<TicketBindingRecord | undefined> {
    return this.storage.get<TicketBindingRecord>(`${TICKET_KEY_PREFIX}${ticketFingerprint}`);
  }

  async putExposure(exposureId: string, record: ExposureBindingRecord): Promise<void> {
    await this.storage.put(`${EXPOSURE_KEY_PREFIX}${exposureId}`, record);
  }

  async putTicket(ticketFingerprint: string, record: TicketBindingRecord): Promise<void> {
    await this.storage.put(`${TICKET_KEY_PREFIX}${ticketFingerprint}`, record);
  }

  async deleteExposure(exposureId: string): Promise<void> {
    await this.storage.delete(`${EXPOSURE_KEY_PREFIX}${exposureId}`);
  }

  async deleteTicket(ticketFingerprint: string): Promise<void> {
    await this.storage.delete(`${TICKET_KEY_PREFIX}${ticketFingerprint}`);
  }

  async deleteExpired(nowMs: number): Promise<number | null> {
    const cursor = await this.storage.get<SweepCursor>(SWEEP_CURSOR_KEY);
    const entries = await this.storage.list<ExposureBindingRecord | TicketBindingRecord>({
      limit: EXPOSURE_REDEMPTION_SWEEP_PAGE_SIZE,
      ...(cursor !== undefined ? { startAfter: cursor.after } : {}),
    });
    const { expiredKeys, pageNextExpiry } = collectExpiredKeys(entries, nowMs);
    if (expiredKeys.length > 0) await this.storage.delete(expiredKeys);

    const nextExpiry = minExpiry(cursor?.nextExpiry ?? null, pageNextExpiry);
    if (entries.size >= EXPOSURE_REDEMPTION_SWEEP_PAGE_SIZE) {
      await this.persistSweepCursor(entries, nextExpiry);
      // Full page: more keys may remain — re-arm immediately to continue.
      return nowMs;
    }

    if (cursor !== undefined) await this.storage.delete(SWEEP_CURSOR_KEY);
    return nextExpiry;
  }

  private async persistSweepCursor(
    entries: Map<string, ExposureBindingRecord | TicketBindingRecord>,
    nextExpiry: number | null,
  ): Promise<void> {
    const lastKey = [...entries.keys()].at(-1);
    if (lastKey === undefined) return;
    await this.storage.put(SWEEP_CURSOR_KEY, {
      after: lastKey,
      nextExpiry,
    } satisfies SweepCursor);
  }

  async setExpiryAlarm(expiresAt: number): Promise<void> {
    const existing = await this.storage.getAlarm();
    // Only move the alarm earlier (or arm when unset). Overwriting with a later
    // time would let nearer-expiring records outlive their TTL.
    if (existing === null || existing > expiresAt) {
      await this.storage.setAlarm(expiresAt);
    }
  }
}

function claimRecordExpiresAt(key: string, record: unknown): number | null {
  if (!(key.startsWith(EXPOSURE_KEY_PREFIX) || key.startsWith(TICKET_KEY_PREFIX))) return null;
  if (typeof record !== "object" || record === null || !("expiresAt" in record)) return null;
  return typeof record.expiresAt === "number" ? record.expiresAt : null;
}

function collectExpiredKeys(
  entries: Map<string, ExposureBindingRecord | TicketBindingRecord>,
  nowMs: number,
): { expiredKeys: string[]; pageNextExpiry: number | null } {
  const expiredKeys: string[] = [];
  let pageNextExpiry: number | null = null;
  for (const [key, record] of entries) {
    if (key === SWEEP_CURSOR_KEY) continue;
    const expiresAt = claimRecordExpiresAt(key, record);
    if (expiresAt === null) continue;
    if (expiresAt <= nowMs) expiredKeys.push(key);
    else pageNextExpiry = minExpiry(pageNextExpiry, expiresAt);
  }
  return { expiredKeys, pageNextExpiry };
}

function minExpiry(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

async function parseClaimBody(request: Request): Promise<ClaimBody | null> {
  try {
    const body = (await request.json()) as {
      exposureId?: unknown;
      ticketFingerprint?: unknown;
      nowMs?: unknown;
    };
    if (
      typeof body.exposureId !== "string" ||
      body.exposureId.length === 0 ||
      typeof body.ticketFingerprint !== "string" ||
      body.ticketFingerprint.length === 0
    ) {
      return null;
    }
    // Reject present-but-invalid nowMs the same way as a bad exposureId — never
    // silently substitute Date.now().
    if (
      body.nowMs !== undefined &&
      (typeof body.nowMs !== "number" || !Number.isFinite(body.nowMs))
    ) {
      return null;
    }
    return {
      exposureId: body.exposureId,
      ticketFingerprint: body.ticketFingerprint,
      nowMs: typeof body.nowMs === "number" ? body.nowMs : Date.now(),
    };
  } catch {
    return null;
  }
}
