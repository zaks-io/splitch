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

/** Minimal DO context the claim handler needs — keeps tests free of cloudflare:workers. */
export interface ExposureRedemptionClaimDoContext {
  readonly storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

type ClaimBody = {
  exposureId: string;
  ticketFingerprint: string;
  nowMs?: number;
};

/**
 * Request handler for ExposureRedemptionClaimDurableObject. Extracted so unit
 * tests exercise the real concurrency boundary and routes without importing
 * `cloudflare:workers`.
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
    nowMs: body.nowMs ?? Date.now(),
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
    return runOrConflict(
      ctx,
      () => applyExposureRedemptionMarkSealed(storage, args),
      "markSealed failed",
    );
  }
  if (path === "/acknowledge") {
    return runOrConflict(
      ctx,
      async () => applyExposureRedemptionAcknowledge(storage, args),
      "acknowledge failed",
    );
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

async function runOrConflict(
  ctx: ExposureRedemptionClaimDoContext,
  op: () => Promise<unknown>,
  fallback: string,
): Promise<Response> {
  try {
    const outcome = await ctx.blockConcurrencyWhile(op);
    return Response.json(outcome === undefined ? { ok: true } : outcome);
  } catch (cause) {
    return Response.json(
      { error: cause instanceof Error ? cause.message : fallback },
      { status: 409 },
    );
  }
}

export async function runExposureRedemptionClaimAlarm(
  storageApi: DurableObjectStorage,
): Promise<void> {
  const storage = new DurableClaimStorage(storageApi);
  const nextExpiry = await storage.deleteExpired(Date.now());
  if (nextExpiry !== null) {
    await storage.setExpiryAlarm(nextExpiry);
  }
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
    const entries = await this.storage.list<ExposureBindingRecord | TicketBindingRecord>();
    const expiredKeys: string[] = [];
    let nextExpiry: number | null = null;
    for (const [key, record] of entries) {
      const expiresAt = claimRecordExpiresAt(key, record);
      if (expiresAt === null) continue;
      if (expiresAt <= nowMs) expiredKeys.push(key);
      else nextExpiry = nextExpiry === null ? expiresAt : Math.min(nextExpiry, expiresAt);
    }
    if (expiredKeys.length > 0) await this.storage.delete(expiredKeys);
    return nextExpiry;
  }

  async setExpiryAlarm(expiresAt: number): Promise<void> {
    const existing = await this.storage.getAlarm();
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
    return {
      exposureId: body.exposureId,
      ticketFingerprint: body.ticketFingerprint,
      nowMs: typeof body.nowMs === "number" && Number.isFinite(body.nowMs) ? body.nowMs : undefined,
    };
  } catch {
    return null;
  }
}
