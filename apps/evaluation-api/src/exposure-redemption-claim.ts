/**
 * Strongly consistent Exposure Ticket redemption claims (SPL-345).
 *
 * One atomic operation owns both the client `exposureId` and the ticket
 * fingerprint so a ticket cannot amplify across fresh IDs, and an exact-ID
 * retry can resume a pending claim after transient ingest failure.
 */

export const EXPOSURE_REDEMPTION_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

type ExposureRedemptionDelivery = "pending" | "accepted";

export type ExposureRedemptionClaimOutcome =
  | { readonly status: "acquired" }
  | { readonly status: "resume" }
  | { readonly status: "deduplicated" }
  | { readonly status: "conflict" };

export type ExposureRedemptionAcknowledgeOutcome =
  | { readonly status: "accepted" }
  | { readonly status: "already_accepted" };

export interface ExposureRedemptionClaimInput {
  readonly appId: string;
  readonly environmentId: string;
  readonly exposureId: string;
  readonly ticketFingerprint: string;
  readonly nowMs?: number;
}

export interface ExposureRedemptionClaimStore {
  claim(input: ExposureRedemptionClaimInput): Promise<ExposureRedemptionClaimOutcome>;
  acknowledge(input: ExposureRedemptionClaimInput): Promise<ExposureRedemptionAcknowledgeOutcome>;
}

export interface ExposureBindingRecord {
  readonly ticketFingerprint: string;
  readonly delivery: ExposureRedemptionDelivery;
  readonly expiresAt: number;
}

export interface TicketBindingRecord {
  readonly ownerExposureId: string;
  readonly delivery: ExposureRedemptionDelivery;
  readonly expiresAt: number;
}

export interface ExposureRedemptionClaimStorage {
  getExposure(exposureId: string): Promise<ExposureBindingRecord | undefined>;
  getTicket(ticketFingerprint: string): Promise<TicketBindingRecord | undefined>;
  putExposure(exposureId: string, record: ExposureBindingRecord): Promise<void>;
  putTicket(ticketFingerprint: string, record: TicketBindingRecord): Promise<void>;
  deleteExpired(nowMs: number): Promise<void>;
  setExpiryAlarm(expiresAt: number): Promise<void>;
}

/**
 * Pure claim state machine over scoped storage. Callers must serialize
 * concurrent mutations (Durable Object `blockConcurrencyWhile` or equivalent).
 */
export async function applyExposureRedemptionClaim(
  storage: ExposureRedemptionClaimStorage,
  input: {
    readonly exposureId: string;
    readonly ticketFingerprint: string;
    readonly nowMs: number;
  },
): Promise<ExposureRedemptionClaimOutcome> {
  await storage.deleteExpired(input.nowMs);

  const existingExposure = await storage.getExposure(input.exposureId);
  if (existingExposure !== undefined && existingExposure.expiresAt > input.nowMs) {
    if (existingExposure.ticketFingerprint !== input.ticketFingerprint) {
      return { status: "conflict" };
    }
    if (existingExposure.delivery === "accepted") {
      return { status: "deduplicated" };
    }
    return { status: "resume" };
  }

  const existingTicket = await storage.getTicket(input.ticketFingerprint);
  if (existingTicket !== undefined && existingTicket.expiresAt > input.nowMs) {
    // Fresh exposureId against an already-owned ticket: bind the ID permanently
    // to this fingerprint so a later different ticket cannot reuse it.
    await storage.putExposure(input.exposureId, {
      ticketFingerprint: input.ticketFingerprint,
      delivery: existingTicket.delivery,
      expiresAt: existingTicket.expiresAt,
    });
    return { status: "deduplicated" };
  }

  const expiresAt = input.nowMs + EXPOSURE_REDEMPTION_CLAIM_TTL_MS;
  await storage.putExposure(input.exposureId, {
    ticketFingerprint: input.ticketFingerprint,
    delivery: "pending",
    expiresAt,
  });
  await storage.putTicket(input.ticketFingerprint, {
    ownerExposureId: input.exposureId,
    delivery: "pending",
    expiresAt,
  });
  await storage.setExpiryAlarm(expiresAt);
  return { status: "acquired" };
}

export async function applyExposureRedemptionAcknowledge(
  storage: ExposureRedemptionClaimStorage,
  input: {
    readonly exposureId: string;
    readonly ticketFingerprint: string;
    readonly nowMs: number;
  },
): Promise<ExposureRedemptionAcknowledgeOutcome> {
  await storage.deleteExpired(input.nowMs);

  const existingExposure = await storage.getExposure(input.exposureId);
  if (
    existingExposure === undefined ||
    existingExposure.expiresAt <= input.nowMs ||
    existingExposure.ticketFingerprint !== input.ticketFingerprint
  ) {
    throw new Error("exposure redemption claim is missing or mismatched at acknowledge");
  }

  if (existingExposure.delivery === "accepted") {
    return { status: "already_accepted" };
  }

  const existingTicket = await storage.getTicket(input.ticketFingerprint);
  const expiresAt =
    existingTicket !== undefined && existingTicket.expiresAt > input.nowMs
      ? existingTicket.expiresAt
      : existingExposure.expiresAt;

  await storage.putExposure(input.exposureId, {
    ticketFingerprint: input.ticketFingerprint,
    delivery: "accepted",
    expiresAt,
  });
  await storage.putTicket(input.ticketFingerprint, {
    ownerExposureId: existingTicket?.ownerExposureId ?? input.exposureId,
    delivery: "accepted",
    expiresAt,
  });
  await storage.setExpiryAlarm(expiresAt);
  return { status: "accepted" };
}

export interface ExposureRedemptionClaimNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

export function exposureRedemptionClaimScopeName(appId: string, environmentId: string): string {
  return `${appId}\u001f${environmentId}`;
}

/** Durable Object-backed claim store (Worker runtime). */
export class DurableExposureRedemptionClaimStore implements ExposureRedemptionClaimStore {
  constructor(private readonly namespace: ExposureRedemptionClaimNamespace) {}

  async claim(input: ExposureRedemptionClaimInput): Promise<ExposureRedemptionClaimOutcome> {
    return this.rpc("/claim", input, parseClaimOutcome);
  }

  async acknowledge(
    input: ExposureRedemptionClaimInput,
  ): Promise<ExposureRedemptionAcknowledgeOutcome> {
    return this.rpc("/acknowledge", input, parseAcknowledgeOutcome);
  }

  private async rpc<T>(
    path: "/claim" | "/acknowledge",
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
      value.status === "resume" ||
      value.status === "deduplicated" ||
      value.status === "conflict")
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

/** In-memory claim store for unit harnesses (single-isolate). */
export class MemoryExposureRedemptionClaimStore implements ExposureRedemptionClaimStore {
  private readonly byScope = new Map<string, MemoryClaimScope>();

  async claim(input: ExposureRedemptionClaimInput): Promise<ExposureRedemptionClaimOutcome> {
    const scope = this.scopeFor(input.appId, input.environmentId);
    return applyExposureRedemptionClaim(scope, {
      exposureId: input.exposureId,
      ticketFingerprint: input.ticketFingerprint,
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  async acknowledge(
    input: ExposureRedemptionClaimInput,
  ): Promise<ExposureRedemptionAcknowledgeOutcome> {
    const scope = this.scopeFor(input.appId, input.environmentId);
    return applyExposureRedemptionAcknowledge(scope, {
      exposureId: input.exposureId,
      ticketFingerprint: input.ticketFingerprint,
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  private scopeFor(appId: string, environmentId: string): MemoryClaimScope {
    const key = `${appId}\u001f${environmentId}`;
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

  async deleteExpired(nowMs: number): Promise<void> {
    for (const [key, record] of this.byExposureId) {
      if (record.expiresAt <= nowMs) this.byExposureId.delete(key);
    }
    for (const [key, record] of this.byTicket) {
      if (record.expiresAt <= nowMs) this.byTicket.delete(key);
    }
  }

  async setExpiryAlarm(_expiresAt: number): Promise<void> {
    // No-op in memory; tests drive time via nowMs.
  }
}
