import {
  computeEntityFamilyHash,
  computeTargetingKeyHash,
  keyVersionOf,
  type SaltStore,
} from "@splitch/privacy";
import type { ExposureDecision } from "./evaluate-path-types";

/**
 * Opaque Exposure Ticket minting and verification for Precomputed Evaluations
 * (ADR-0048).
 *
 * Ticket = base64url(payload) + "." + base64url(HMAC-SHA256(payload, ticketKey))
 * Verification recomputes the MAC; minting is stateless.
 * docs/spec/sdk/exposures-endpoint.md
 */

const MIN_TICKET_KEY_LENGTH = 32;
const EXPOSURE_IDENTITY_DOMAIN = "splitch-exposure-identity-v1:";
/** Tickets older than 24 hours are rejected EXPOSURE_TICKET_EXPIRED. */
const EXPOSURE_TICKET_TTL_MS = 24 * 60 * 60 * 1000;
const EXPOSURE_TICKET_REFRESH_WINDOW_MS = EXPOSURE_TICKET_TTL_MS / 2;

export interface ExposureTicketPayload {
  readonly app_id: string;
  readonly environment_id: string;
  readonly experiment_id: string;
  readonly run_id: string;
  readonly flag_key: string;
  readonly variant: string;
  readonly id_type: string;
  readonly targeting_key_hash: string;
  readonly entity_family_hash: string;
  readonly identity_version: string;
  readonly issued_at: string;
}

export interface MintExposureTicketDeps {
  readonly saltStore: SaltStore;
  readonly ticketKey: string;
  readonly now?: () => Date;
}

export interface VerifyExposureTicketDeps {
  readonly ticketKey: string;
  /** Immediately previous key retained during rotation (ADR-0044 posture). */
  readonly previousTicketKey?: string;
  readonly now?: () => Date;
}

export type VerifyExposureTicketResult =
  | { readonly ok: true; readonly payload: ExposureTicketPayload }
  | { readonly ok: false; readonly reason: "invalid" | "expired"; readonly issuedAt?: string };

export interface MintedExposureTicket {
  readonly exposureIdentity: string;
  readonly exposureTicket: string;
}

export async function mintExposureTicket(
  exposure: ExposureDecision,
  deps: MintExposureTicketDeps,
): Promise<string> {
  return (await mintExposureTicketWithIdentity(exposure, deps)).exposureTicket;
}

export async function mintExposureTicketWithIdentity(
  exposure: ExposureDecision,
  deps: MintExposureTicketDeps,
): Promise<MintedExposureTicket> {
  assertStrongTicketKey(deps.ticketKey);
  const identity = {
    appId: exposure.appId,
    idType: exposure.idType,
    targetingKey: exposure.targetingKey,
  };
  const [targetingKeyHash, entityFamilyHash] = await Promise.all([
    computeTargetingKeyHash(deps.saltStore, identity),
    computeEntityFamilyHash(deps.saltStore, identity),
  ]);
  const payload: ExposureTicketPayload = {
    app_id: exposure.appId,
    environment_id: exposure.environmentId,
    experiment_id: exposure.experimentId,
    run_id: exposure.liveRunId,
    flag_key: exposure.flagKey,
    variant: exposure.variant,
    id_type: exposure.idType,
    targeting_key_hash: targetingKeyHash,
    entity_family_hash: entityFamilyHash,
    identity_version: keyVersionOf(targetingKeyHash),
    issued_at: (deps.now ?? (() => new Date()))().toISOString(),
  };
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const identityMaterial = bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        app_id: payload.app_id,
        environment_id: payload.environment_id,
        experiment_id: payload.experiment_id,
        run_id: payload.run_id,
        flag_key: payload.flag_key,
        variant: payload.variant,
        id_type: payload.id_type,
        targeting_key_hash: payload.targeting_key_hash,
        entity_family_hash: payload.entity_family_hash,
        identity_version: payload.identity_version,
      }),
    ),
  );
  const [signature, exposureIdentity] = await Promise.all([
    sign(encoded, deps.ticketKey),
    sign(`${EXPOSURE_IDENTITY_DOMAIN}${identityMaterial}`, deps.ticketKey),
  ]);
  return {
    exposureIdentity,
    exposureTicket: `${encoded}.${signature}`,
  };
}

/**
 * Coarse ETag window that refreshes an unread ticket before its TTL can elapse.
 * It is never serialized; routine remints inside the window keep the same tag.
 */
export function exposureTicketRefreshWindow(now: Date): number {
  return Math.floor(now.getTime() / EXPOSURE_TICKET_REFRESH_WINDOW_MS);
}

export async function verifyExposureTicket(
  ticket: string,
  deps: VerifyExposureTicketDeps,
): Promise<VerifyExposureTicketResult> {
  assertStrongTicketKey(deps.ticketKey);
  if (deps.previousTicketKey !== undefined && deps.previousTicketKey.length > 0) {
    assertStrongTicketKey(deps.previousTicketKey);
  }

  const parts = splitTicket(ticket);
  if (parts === null) return { ok: false, reason: "invalid" };

  const macOk = await macMatchesAnyKey(parts.encoded, parts.signature, [
    deps.ticketKey,
    ...(deps.previousTicketKey !== undefined && deps.previousTicketKey.length > 0
      ? [deps.previousTicketKey]
      : []),
  ]);
  if (!macOk) return { ok: false, reason: "invalid" };

  const payload = decodePayload(parts.encoded);
  if (payload === null) return { ok: false, reason: "invalid" };
  return checkTicketFreshness(payload, (deps.now ?? (() => new Date()))().getTime());
}

function splitTicket(ticket: string): { encoded: string; signature: string } | null {
  const parts = ticket.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  if (
    encoded === undefined ||
    signature === undefined ||
    encoded.length === 0 ||
    signature.length === 0
  ) {
    return null;
  }
  return { encoded, signature };
}

async function macMatchesAnyKey(
  encoded: string,
  signature: string,
  keys: readonly string[],
): Promise<boolean> {
  for (const key of keys) {
    if (await verifyMac(encoded, signature, key)) return true;
  }
  return false;
}

function checkTicketFreshness(
  payload: ExposureTicketPayload,
  nowMs: number,
): VerifyExposureTicketResult {
  const issuedAtMs = Date.parse(payload.issued_at);
  if (!Number.isFinite(issuedAtMs)) return { ok: false, reason: "invalid" };
  if (nowMs - issuedAtMs > EXPOSURE_TICKET_TTL_MS) {
    return { ok: false, reason: "expired", issuedAt: payload.issued_at };
  }
  // Reject tickets from the future beyond a small skew window — treat as invalid.
  if (issuedAtMs - nowMs > 5 * 60 * 1000) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, payload };
}

export function assertStrongTicketKey(secret: string): void {
  if (secret.length < MIN_TICKET_KEY_LENGTH) {
    throw new Error(
      `evaluation-api: EXPOSURE_TICKET_KEY must be at least ${MIN_TICKET_KEY_LENGTH} characters`,
    );
  }
}

function decodePayload(encoded: string): ExposureTicketPayload | null {
  try {
    const json = new TextDecoder().decode(base64UrlToBytes(encoded));
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const required = [
      "app_id",
      "environment_id",
      "experiment_id",
      "run_id",
      "flag_key",
      "variant",
      "id_type",
      "targeting_key_hash",
      "entity_family_hash",
      "identity_version",
      "issued_at",
    ] as const;
    for (const field of required) {
      if (typeof record[field] !== "string" || record[field].length === 0) return null;
    }
    return {
      app_id: record.app_id as string,
      environment_id: record.environment_id as string,
      experiment_id: record.experiment_id as string,
      run_id: record.run_id as string,
      flag_key: record.flag_key as string,
      variant: record.variant as string,
      id_type: record.id_type as string,
      targeting_key_hash: record.targeting_key_hash as string,
      entity_family_hash: record.entity_family_hash as string,
      identity_version: record.identity_version as string,
      issued_at: record.issued_at as string,
    };
  } catch {
    return null;
  }
}

async function verifyMac(payload: string, signature: string, secret: string): Promise<boolean> {
  const expected = await sign(payload, secret);
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(padLength));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
