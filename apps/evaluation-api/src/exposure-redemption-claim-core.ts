/**
 * Strongly consistent Exposure Ticket redemption claims (SPL-345).
 *
 * Delivery: pending (seal in flight) → sealed (ingest committed) → accepted.
 * `deduplicated` is returned only after an append has been committed (sealed or
 * accepted). A never-appended ticket must not be reported as success.
 */

export const EXPOSURE_REDEMPTION_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

type ExposureRedemptionDelivery = "pending" | "sealed" | "accepted";

export type ExposureRedemptionClaimOutcome =
  | { readonly status: "acquired" }
  | { readonly status: "resume_ack" }
  | { readonly status: "deduplicated" }
  | { readonly status: "conflict" }
  | { readonly status: "busy" };

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
  release(input: ExposureRedemptionClaimInput): Promise<void>;
  markSealed(input: ExposureRedemptionClaimInput): Promise<void>;
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
  deleteExposure(exposureId: string): Promise<void>;
  deleteTicket(ticketFingerprint: string): Promise<void>;
  /** Alarm-only sweep. Hot-path claim/ack must not call this. */
  deleteExpired(nowMs: number): Promise<number | null>;
  setExpiryAlarm(expiresAt: number): Promise<void>;
}

async function liveExposure(
  storage: ExposureRedemptionClaimStorage,
  exposureId: string,
  nowMs: number,
): Promise<ExposureBindingRecord | undefined> {
  const record = await storage.getExposure(exposureId);
  if (record === undefined) return undefined;
  if (record.expiresAt <= nowMs) {
    await storage.deleteExposure(exposureId);
    return undefined;
  }
  return record;
}

async function liveTicket(
  storage: ExposureRedemptionClaimStorage,
  ticketFingerprint: string,
  nowMs: number,
): Promise<TicketBindingRecord | undefined> {
  const record = await storage.getTicket(ticketFingerprint);
  if (record === undefined) return undefined;
  if (record.expiresAt <= nowMs) {
    await storage.deleteTicket(ticketFingerprint);
    return undefined;
  }
  return record;
}

/**
 * Pure claim state machine. Callers must serialize concurrent mutations
 * (Durable Object `blockConcurrencyWhile` or equivalent).
 */
export async function applyExposureRedemptionClaim(
  storage: ExposureRedemptionClaimStorage,
  input: {
    readonly exposureId: string;
    readonly ticketFingerprint: string;
    readonly nowMs: number;
  },
): Promise<ExposureRedemptionClaimOutcome> {
  const existingExposure = await liveExposure(storage, input.exposureId, input.nowMs);
  if (existingExposure !== undefined) {
    if (existingExposure.ticketFingerprint !== input.ticketFingerprint) {
      return { status: "conflict" };
    }
    if (existingExposure.delivery === "accepted") return { status: "deduplicated" };
    if (existingExposure.delivery === "sealed") return { status: "resume_ack" };
    // pending: another attempt is sealing — never a success ack.
    return { status: "busy" };
  }

  const existingTicket = await liveTicket(storage, input.ticketFingerprint, input.nowMs);
  if (existingTicket !== undefined) {
    if (existingTicket.delivery === "pending") {
      // Ticket claimed but nothing appended yet — not deduplicated.
      return { status: "busy" };
    }
    // sealed or accepted: append already committed; bind this exposureId.
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

export async function applyExposureRedemptionRelease(
  storage: ExposureRedemptionClaimStorage,
  input: {
    readonly exposureId: string;
    readonly ticketFingerprint: string;
    readonly nowMs: number;
  },
): Promise<void> {
  const existingExposure = await liveExposure(storage, input.exposureId, input.nowMs);
  if (
    existingExposure === undefined ||
    existingExposure.ticketFingerprint !== input.ticketFingerprint ||
    existingExposure.delivery !== "pending"
  ) {
    return;
  }
  await storage.deleteExposure(input.exposureId);
  const existingTicket = await liveTicket(storage, input.ticketFingerprint, input.nowMs);
  if (
    existingTicket !== undefined &&
    existingTicket.ownerExposureId === input.exposureId &&
    existingTicket.delivery === "pending"
  ) {
    await storage.deleteTicket(input.ticketFingerprint);
  }
}

export async function applyExposureRedemptionMarkSealed(
  storage: ExposureRedemptionClaimStorage,
  input: {
    readonly exposureId: string;
    readonly ticketFingerprint: string;
    readonly nowMs: number;
  },
): Promise<void> {
  const existingExposure = await liveExposure(storage, input.exposureId, input.nowMs);
  if (
    existingExposure === undefined ||
    existingExposure.expiresAt <= input.nowMs ||
    existingExposure.ticketFingerprint !== input.ticketFingerprint
  ) {
    throw new Error("exposure redemption claim is missing or mismatched at markSealed");
  }
  if (existingExposure.delivery === "accepted" || existingExposure.delivery === "sealed") {
    return;
  }
  const existingTicket = await liveTicket(storage, input.ticketFingerprint, input.nowMs);
  const expiresAt =
    existingTicket !== undefined ? existingTicket.expiresAt : existingExposure.expiresAt;
  await storage.putExposure(input.exposureId, {
    ticketFingerprint: input.ticketFingerprint,
    delivery: "sealed",
    expiresAt,
  });
  await storage.putTicket(input.ticketFingerprint, {
    ownerExposureId: existingTicket?.ownerExposureId ?? input.exposureId,
    delivery: "sealed",
    expiresAt,
  });
  await storage.setExpiryAlarm(expiresAt);
}

export async function applyExposureRedemptionAcknowledge(
  storage: ExposureRedemptionClaimStorage,
  input: {
    readonly exposureId: string;
    readonly ticketFingerprint: string;
    readonly nowMs: number;
  },
): Promise<ExposureRedemptionAcknowledgeOutcome> {
  const existingExposure = await liveExposure(storage, input.exposureId, input.nowMs);
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
  if (existingExposure.delivery !== "sealed") {
    throw new Error("exposure redemption claim must be sealed before acknowledge");
  }

  const existingTicket = await liveTicket(storage, input.ticketFingerprint, input.nowMs);
  const expiresAt =
    existingTicket !== undefined ? existingTicket.expiresAt : existingExposure.expiresAt;
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
