import { computeTargetingKeyHash, type SaltStore } from "@splitch/privacy";
import type { ExposureDecision } from "./evaluate-path-types";

/**
 * Opaque Exposure Ticket minting for Precomputed Evaluations (ADR-0048).
 *
 * Ticket = base64url(payload) + "." + base64url(HMAC-SHA256(payload, ticketKey))
 * Verification (exposures route) recomputes the MAC; minting is stateless.
 * docs/spec/sdk/exposures-endpoint.md
 */

const MIN_TICKET_KEY_LENGTH = 32;

export interface ExposureTicketPayload {
  readonly app_id: string;
  readonly environment_id: string;
  readonly experiment_id: string;
  readonly run_id: string;
  readonly flag_key: string;
  readonly variant: string;
  readonly id_type: string;
  readonly targeting_key_hash: string;
  readonly issued_at: string;
}

export interface MintExposureTicketDeps {
  readonly saltStore: SaltStore;
  readonly ticketKey: string;
  readonly now?: () => Date;
}

export async function mintExposureTicket(
  exposure: ExposureDecision,
  deps: MintExposureTicketDeps,
): Promise<string> {
  assertStrongTicketKey(deps.ticketKey);
  const targetingKeyHash = await computeTargetingKeyHash(deps.saltStore, {
    appId: exposure.appId,
    idType: exposure.idType,
    targetingKey: exposure.targetingKey,
  });
  const payload: ExposureTicketPayload = {
    app_id: exposure.appId,
    environment_id: exposure.environmentId,
    experiment_id: exposure.experimentId,
    run_id: exposure.liveRunId,
    flag_key: exposure.flagKey,
    variant: exposure.variant,
    id_type: exposure.idType,
    targeting_key_hash: targetingKeyHash,
    issued_at: (deps.now ?? (() => new Date()))().toISOString(),
  };
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${encoded}.${await sign(encoded, deps.ticketKey)}`;
}

export function assertStrongTicketKey(secret: string): void {
  if (secret.length < MIN_TICKET_KEY_LENGTH) {
    throw new Error(
      `evaluation-api: EXPOSURE_TICKET_KEY must be at least ${MIN_TICKET_KEY_LENGTH} characters`,
    );
  }
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
