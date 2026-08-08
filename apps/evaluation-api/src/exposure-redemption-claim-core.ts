/**
 * Strongly consistent Exposure Ticket redemption claims (SPL-345).
 *
 * Delivery: pending (seal in flight) → sealed (ingest committed) → accepted.
 * `deduplicated` is returned only after an append has been committed (sealed or
 * accepted). A never-appended ticket must not be reported as success.
 */

/**
 * How long sealed/accepted ownership is remembered (ticket-window scale).
 * Distinct from the pending lease below — do not collapse them.
 */
export const EXPOSURE_REDEMPTION_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a `pending` claim may block the ticket before a retry may re-acquire.
 *
 * Sized for the redeem operation (claim → ingest → seal), not the ticket TTL.
 * A lost claim RPC / isolate kill between claim and ingest leaves a pending
 * tombstone; after this lease a retry re-acquires. That may append a second raw
 * row in the ambiguous window (ingest may already have landed); Tinybird
 * `cp_deduped_exposures` collapses subject-identity duplicates, so analysis is
 * unaffected. A 24h pending tombstone that reports busy forever with nothing
 * appended is the silent-loss direction ADR-0036 forbids — prefer the duplicate
 * raw row. Do not "fix" this back to the claim TTL.
 */
export const EXPOSURE_REDEMPTION_PENDING_LEASE_MS = 30_000;

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

export type ExposureRedemptionMutationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

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
 * (Durable Object `blockConcurrencyWhile` or equivalent). Never throws —
 * conflict outcomes are returned so workerd does not abort the DO.
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
    return claimAgainstExistingExposure(storage, input, existingExposure);
  }

  const existingTicket = await liveTicket(storage, input.ticketFingerprint, input.nowMs);
  if (existingTicket !== undefined) {
    return claimAgainstExistingTicket(storage, input, existingTicket);
  }

  return acquirePendingClaim(storage, input);
}

async function claimAgainstExistingExposure(
  storage: ExposureRedemptionClaimStorage,
  input: {
    readonly exposureId: string;
    readonly ticketFingerprint: string;
    readonly nowMs: number;
  },
  existingExposure: ExposureBindingRecord,
): Promise<ExposureRedemptionClaimOutcome> {
  if (existingExposure.ticketFingerprint !== input.ticketFingerprint) {
    return { status: "conflict" };
  }
  if (existingExposure.delivery === "accepted") return { status: "deduplicated" };
  if (existingExposure.delivery === "pending") return { status: "busy" };
  // sealed: only the owner that sealed may resume_ack. A rebound exposureId
  // that bound after another owner sealed must keep answering deduplicated.
  const ticket = await liveTicket(storage, input.ticketFingerprint, input.nowMs);
  if (ticket !== undefined && ticket.ownerExposureId === input.exposureId) {
    return { status: "resume_ack" };
  }
  return { status: "deduplicated" };
}

async function claimAgainstExistingTicket(
  storage: ExposureRedemptionClaimStorage,
  input: {
    readonly exposureId: string;
    readonly ticketFingerprint: string;
    readonly nowMs: number;
  },
  existingTicket: TicketBindingRecord,
): Promise<ExposureRedemptionClaimOutcome> {
  if (existingTicket.delivery === "pending") {
    return { status: "busy" };
  }
  await storage.putExposure(input.exposureId, {
    ticketFingerprint: input.ticketFingerprint,
    delivery: existingTicket.delivery,
    expiresAt: existingTicket.expiresAt,
  });
  return { status: "deduplicated" };
}

async function acquirePendingClaim(
  storage: ExposureRedemptionClaimStorage,
  input: {
    readonly exposureId: string;
    readonly ticketFingerprint: string;
    readonly nowMs: number;
  },
): Promise<ExposureRedemptionClaimOutcome> {
  const expiresAt = input.nowMs + EXPOSURE_REDEMPTION_PENDING_LEASE_MS;
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
): Promise<ExposureRedemptionMutationResult<null>> {
  const existingExposure = await liveExposure(storage, input.exposureId, input.nowMs);
  if (
    existingExposure === undefined ||
    existingExposure.expiresAt <= input.nowMs ||
    existingExposure.ticketFingerprint !== input.ticketFingerprint
  ) {
    return {
      ok: false,
      error: "exposure redemption claim is missing or mismatched at markSealed",
    };
  }
  if (existingExposure.delivery === "accepted" || existingExposure.delivery === "sealed") {
    return { ok: true, value: null };
  }
  const existingTicket = await liveTicket(storage, input.ticketFingerprint, input.nowMs);
  if (existingTicket === undefined) {
    return {
      ok: false,
      error:
        "exposure redemption ticket binding missing while exposure claim is live at markSealed",
    };
  }
  if (existingTicket.ownerExposureId !== input.exposureId) {
    return {
      ok: false,
      error: "exposure redemption ticket owner mismatches exposure claim at markSealed",
    };
  }
  const expiresAt = input.nowMs + EXPOSURE_REDEMPTION_CLAIM_TTL_MS;
  await storage.putExposure(input.exposureId, {
    ticketFingerprint: input.ticketFingerprint,
    delivery: "sealed",
    expiresAt,
  });
  await storage.putTicket(input.ticketFingerprint, {
    ownerExposureId: existingTicket.ownerExposureId,
    delivery: "sealed",
    expiresAt,
  });
  await storage.setExpiryAlarm(expiresAt);
  return { ok: true, value: null };
}

export async function applyExposureRedemptionAcknowledge(
  storage: ExposureRedemptionClaimStorage,
  input: {
    readonly exposureId: string;
    readonly ticketFingerprint: string;
    readonly nowMs: number;
  },
): Promise<ExposureRedemptionMutationResult<ExposureRedemptionAcknowledgeOutcome>> {
  const existingExposure = await liveExposure(storage, input.exposureId, input.nowMs);
  if (
    existingExposure === undefined ||
    existingExposure.expiresAt <= input.nowMs ||
    existingExposure.ticketFingerprint !== input.ticketFingerprint
  ) {
    return {
      ok: false,
      error: "exposure redemption claim is missing or mismatched at acknowledge",
    };
  }
  if (existingExposure.delivery === "accepted") {
    return { ok: true, value: { status: "already_accepted" } };
  }
  if (existingExposure.delivery !== "sealed") {
    return {
      ok: false,
      error: "exposure redemption claim must be sealed before acknowledge",
    };
  }

  const existingTicket = await liveTicket(storage, input.ticketFingerprint, input.nowMs);
  if (existingTicket === undefined) {
    return {
      ok: false,
      error:
        "exposure redemption ticket binding missing while exposure claim is live at acknowledge",
    };
  }
  if (existingTicket.ownerExposureId !== input.exposureId) {
    return {
      ok: false,
      error: "exposure redemption ticket owner mismatches exposure claim at acknowledge",
    };
  }
  const expiresAt =
    existingTicket.expiresAt > input.nowMs
      ? existingTicket.expiresAt
      : input.nowMs + EXPOSURE_REDEMPTION_CLAIM_TTL_MS;
  await storage.putExposure(input.exposureId, {
    ticketFingerprint: input.ticketFingerprint,
    delivery: "accepted",
    expiresAt,
  });
  await storage.putTicket(input.ticketFingerprint, {
    ownerExposureId: existingTicket.ownerExposureId,
    delivery: "accepted",
    expiresAt,
  });
  await storage.setExpiryAlarm(expiresAt);
  return { ok: true, value: { status: "accepted" } };
}
