import {
  applyExposureRedemptionAcknowledge,
  applyExposureRedemptionClaim,
  applyExposureRedemptionMarkSealed,
  applyExposureRedemptionRelease,
  type ExposureBindingRecord,
  type ExposureRedemptionAcknowledgeOutcome,
  type ExposureRedemptionClaimInput,
  type ExposureRedemptionClaimOutcome,
  type ExposureRedemptionClaimStorage,
  type ExposureRedemptionClaimStore,
  type TicketBindingRecord,
} from "./exposure-redemption-claim-core";

export interface ExposureRedemptionClaimNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

function exposureRedemptionClaimScopeName(appId: string, environmentId: string): string {
  return `${appId}\u001f${environmentId}`;
}

/** Durable Object-backed claim store (Worker runtime). */
export class DurableExposureRedemptionClaimStore implements ExposureRedemptionClaimStore {
  constructor(private readonly namespace: ExposureRedemptionClaimNamespace) {}

  async claim(input: ExposureRedemptionClaimInput): Promise<ExposureRedemptionClaimOutcome> {
    return this.rpc("/claim", input, parseClaimOutcome);
  }

  async release(input: ExposureRedemptionClaimInput): Promise<void> {
    await this.rpc("/release", input, parseOk);
  }

  async markSealed(input: ExposureRedemptionClaimInput): Promise<void> {
    await this.rpc("/markSealed", input, parseOk);
  }

  async acknowledge(
    input: ExposureRedemptionClaimInput,
  ): Promise<ExposureRedemptionAcknowledgeOutcome> {
    return this.rpc("/acknowledge", input, parseAcknowledgeOutcome);
  }

  private async rpc<T>(
    path: "/claim" | "/release" | "/markSealed" | "/acknowledge",
    input: ExposureRedemptionClaimInput,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const name = exposureRedemptionClaimScopeName(input.appId, input.environmentId);
    const stub = this.namespace.get(this.namespace.idFromName(name));
    let response: Response;
    try {
      response = await stub.fetch(`https://exposure-redemption-claim.local${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          exposureId: input.exposureId,
          ticketFingerprint: input.ticketFingerprint,
          nowMs: input.nowMs,
        }),
      });
    } catch (cause) {
      throw new Error("exposure redemption claim Durable Object transport failed", { cause });
    }
    if (!response.ok) {
      throw new Error(`exposure redemption claim Durable Object returned HTTP ${response.status}`);
    }
    return parse(await response.json());
  }
}

function parseClaimOutcome(value: unknown): ExposureRedemptionClaimOutcome {
  if (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value.status === "acquired" ||
      value.status === "resume_ack" ||
      value.status === "deduplicated" ||
      value.status === "conflict" ||
      value.status === "busy")
  ) {
    return { status: value.status };
  }
  throw new Error("exposure redemption claim returned an invalid outcome");
}

function parseAcknowledgeOutcome(value: unknown): ExposureRedemptionAcknowledgeOutcome {
  if (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value.status === "accepted" || value.status === "already_accepted")
  ) {
    return { status: value.status };
  }
  throw new Error("exposure redemption acknowledge returned an invalid outcome");
}

function parseOk(value: unknown): void {
  if (typeof value === "object" && value !== null && "ok" in value && value.ok === true) {
    return;
  }
  throw new Error("exposure redemption claim returned an invalid ok response");
}

/** In-memory claim store for unit harnesses (single-isolate). */
export class MemoryExposureRedemptionClaimStore implements ExposureRedemptionClaimStore {
  private readonly byScope = new Map<string, MemoryClaimScope>();

  async claim(input: ExposureRedemptionClaimInput): Promise<ExposureRedemptionClaimOutcome> {
    return applyExposureRedemptionClaim(this.scopeFor(input), {
      exposureId: input.exposureId,
      ticketFingerprint: input.ticketFingerprint,
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  async release(input: ExposureRedemptionClaimInput): Promise<void> {
    await applyExposureRedemptionRelease(this.scopeFor(input), {
      exposureId: input.exposureId,
      ticketFingerprint: input.ticketFingerprint,
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  async markSealed(input: ExposureRedemptionClaimInput): Promise<void> {
    await applyExposureRedemptionMarkSealed(this.scopeFor(input), {
      exposureId: input.exposureId,
      ticketFingerprint: input.ticketFingerprint,
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  async acknowledge(
    input: ExposureRedemptionClaimInput,
  ): Promise<ExposureRedemptionAcknowledgeOutcome> {
    return applyExposureRedemptionAcknowledge(this.scopeFor(input), {
      exposureId: input.exposureId,
      ticketFingerprint: input.ticketFingerprint,
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  private scopeFor(input: ExposureRedemptionClaimInput): MemoryClaimScope {
    const key = `${input.appId}\u001f${input.environmentId}`;
    const existing = this.byScope.get(key);
    if (existing) return existing;
    const created = new MemoryClaimScope();
    this.byScope.set(key, created);
    return created;
  }
}

class MemoryClaimScope implements ExposureRedemptionClaimStorage {
  private readonly byExposureId = new Map<string, ExposureBindingRecord>();
  private readonly byTicket = new Map<string, TicketBindingRecord>();

  async getExposure(exposureId: string): Promise<ExposureBindingRecord | undefined> {
    return this.byExposureId.get(exposureId);
  }

  async getTicket(ticketFingerprint: string): Promise<TicketBindingRecord | undefined> {
    return this.byTicket.get(ticketFingerprint);
  }

  async putExposure(exposureId: string, record: ExposureBindingRecord): Promise<void> {
    this.byExposureId.set(exposureId, record);
  }

  async putTicket(ticketFingerprint: string, record: TicketBindingRecord): Promise<void> {
    this.byTicket.set(ticketFingerprint, record);
  }

  async deleteExposure(exposureId: string): Promise<void> {
    this.byExposureId.delete(exposureId);
  }

  async deleteTicket(ticketFingerprint: string): Promise<void> {
    this.byTicket.delete(ticketFingerprint);
  }

  async deleteExpired(nowMs: number): Promise<number | null> {
    const nextExposure = purgeExpiredMap(this.byExposureId, nowMs);
    const nextTicket = purgeExpiredMap(this.byTicket, nowMs);
    if (nextExposure === null) return nextTicket;
    if (nextTicket === null) return nextExposure;
    return Math.min(nextExposure, nextTicket);
  }

  async setExpiryAlarm(_expiresAt: number): Promise<void> {}
}

function purgeExpiredMap(map: Map<string, { expiresAt: number }>, nowMs: number): number | null {
  let next: number | null = null;
  for (const [key, record] of map) {
    if (record.expiresAt <= nowMs) {
      map.delete(key);
      continue;
    }
    next = next === null ? record.expiresAt : Math.min(next, record.expiresAt);
  }
  return next;
}
