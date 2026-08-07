import { DurableObject } from "cloudflare:workers";
import {
  applyExposureRedemptionAcknowledge,
  applyExposureRedemptionClaim,
  type ExposureBindingRecord,
  type ExposureRedemptionClaimStorage,
  type TicketBindingRecord,
} from "./exposure-redemption-claim";

const EXPOSURE_KEY_PREFIX = "exposure:";
const TICKET_KEY_PREFIX = "ticket:";

/**
 * One Durable Object per App + Environment serializes redemption claims so
 * exposureId and ticket-fingerprint ownership move together.
 */
export class ExposureRedemptionClaimDurableObject extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const body = await parseClaimBody(request);
    if (body === null) {
      return Response.json({ error: "invalid claim payload" }, { status: 400 });
    }

    const storage = new DurableClaimStorage(this.ctx);
    const nowMs = body.nowMs ?? Date.now();

    if (path === "/claim") {
      const outcome = await this.ctx.blockConcurrencyWhile(() =>
        applyExposureRedemptionClaim(storage, {
          exposureId: body.exposureId,
          ticketFingerprint: body.ticketFingerprint,
          nowMs,
        }),
      );
      return Response.json(outcome);
    }

    if (path === "/acknowledge") {
      try {
        const outcome = await this.ctx.blockConcurrencyWhile(() =>
          applyExposureRedemptionAcknowledge(storage, {
            exposureId: body.exposureId,
            ticketFingerprint: body.ticketFingerprint,
            nowMs,
          }),
        );
        return Response.json(outcome);
      } catch (cause) {
        return Response.json(
          { error: cause instanceof Error ? cause.message : "acknowledge failed" },
          { status: 409 },
        );
      }
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }

  override async alarm(): Promise<void> {
    const storage = new DurableClaimStorage(this.ctx);
    await storage.deleteExpired(Date.now());
  }
}

class DurableClaimStorage implements ExposureRedemptionClaimStorage {
  constructor(private readonly ctx: DurableObjectState) {}

  async getExposure(exposureId: string): Promise<ExposureBindingRecord | undefined> {
    return this.ctx.storage.get<ExposureBindingRecord>(`${EXPOSURE_KEY_PREFIX}${exposureId}`);
  }

  async getTicket(ticketFingerprint: string): Promise<TicketBindingRecord | undefined> {
    return this.ctx.storage.get<TicketBindingRecord>(`${TICKET_KEY_PREFIX}${ticketFingerprint}`);
  }

  async putExposure(exposureId: string, record: ExposureBindingRecord): Promise<void> {
    await this.ctx.storage.put(`${EXPOSURE_KEY_PREFIX}${exposureId}`, record);
  }

  async putTicket(ticketFingerprint: string, record: TicketBindingRecord): Promise<void> {
    await this.ctx.storage.put(`${TICKET_KEY_PREFIX}${ticketFingerprint}`, record);
  }

  async deleteExpired(nowMs: number): Promise<void> {
    const entries = await this.ctx.storage.list<ExposureBindingRecord | TicketBindingRecord>();
    const expiredKeys: string[] = [];
    for (const [key, record] of entries) {
      if (
        (key.startsWith(EXPOSURE_KEY_PREFIX) || key.startsWith(TICKET_KEY_PREFIX)) &&
        typeof record === "object" &&
        record !== null &&
        "expiresAt" in record &&
        typeof record.expiresAt === "number" &&
        record.expiresAt <= nowMs
      ) {
        expiredKeys.push(key);
      }
    }
    if (expiredKeys.length > 0) {
      await this.ctx.storage.delete(expiredKeys);
    }
  }

  async setExpiryAlarm(expiresAt: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > expiresAt) {
      await this.ctx.storage.setAlarm(expiresAt);
    }
  }
}

async function parseClaimBody(request: Request): Promise<{
  exposureId: string;
  ticketFingerprint: string;
  nowMs?: number;
} | null> {
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
