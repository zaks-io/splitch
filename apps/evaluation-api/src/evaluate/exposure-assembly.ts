import type { ExposureEvent } from "@splitch/contracts";
import { computeEntityFamilyHash, computeTargetingKeyHash, type SaltStore } from "@splitch/privacy";
import type { EvaluatePathInput, EvaluateResult } from "./evaluate-path-types";
import type { ExposureTicketPayload } from "./exposure-ticket";

const EXPOSURE_TYPE = "exposure" as const;

export interface ExposureAssemblyDeps {
  readonly saltStore: SaltStore;
  readonly sourceId: () => string;
  readonly newEventId?: () => string;
  readonly now?: () => Date;
}

export type AssembledExposure = ExposureEvent & {
  readonly isHoldover: false;
};

export type ExposureAssemblyResult = readonly [AssembledExposure] | readonly [];

export async function assembleEvaluateExposures(
  input: Pick<EvaluatePathInput, "appId" | "environmentId" | "evaluationContext">,
  result: EvaluateResult,
  deps: ExposureAssemblyDeps,
): Promise<ExposureAssemblyResult> {
  if (result.exposure === null || result.liveRunId === null) {
    return [];
  }

  const sourceId = deps.sourceId();
  const timestamp = (deps.now ?? (() => new Date()))().toISOString();
  const eventId = (deps.newEventId ?? (() => crypto.randomUUID()))();
  const identity = {
    appId: input.appId,
    idType: result.exposure.idType,
    targetingKey: input.evaluationContext.targetingKey,
  };
  const [targetingKeyHash, entityFamilyHash] = await Promise.all([
    computeTargetingKeyHash(deps.saltStore, identity),
    computeEntityFamilyHash(deps.saltStore, identity),
  ]);
  const runId = result.liveRunId;
  const dedupKey = await exposureDedupKey({
    appId: input.appId,
    eventId,
    experimentId: result.exposure.experimentId,
    idType: result.exposure.idType,
    runId,
    sourceId,
    targetingKeyHash,
    type: EXPOSURE_TYPE,
  });

  return [
    {
      appId: input.appId,
      environmentId: input.environmentId,
      experimentId: result.exposure.experimentId,
      runId,
      idType: result.exposure.idType,
      targetingKeyHash,
      entityFamilyHash,
      variantName: result.exposure.variant,
      type: EXPOSURE_TYPE,
      eventId,
      dedupKey,
      sourceId,
      counterfactual: false,
      isHoldover: false,
      clientTimestamp: timestamp,
      exposureAt: timestamp,
      serverReceivedAt: timestamp,
    },
  ];
}

/**
 * Seal a canonical Exposure from a verified ticket. Every Exposure-relevant field
 * comes from the ticket — never from client assertion (ADR-0048) — except the
 * write-scope App/Environment, which come from the authenticated credential so a
 * future tenant-gate regression cannot mis-attribute a write (ADR-0018).
 * `exposureId` is the retry-stable physical event id (SDK-owned).
 */
export async function assembleExposureFromTicket(input: {
  readonly ticket: ExposureTicketPayload;
  readonly appId: string;
  readonly environmentId: string;
  readonly exposureId: string;
  readonly clientTimestamp: string;
  readonly sourceId: string;
  readonly now?: () => Date;
}): Promise<AssembledExposure> {
  const serverReceivedAt = (input.now ?? (() => new Date()))().toISOString();
  const dedupKey = await exposureDedupKey({
    appId: input.appId,
    eventId: input.exposureId,
    experimentId: input.ticket.experiment_id,
    idType: input.ticket.id_type,
    runId: input.ticket.run_id,
    sourceId: input.sourceId,
    targetingKeyHash: input.ticket.targeting_key_hash,
    type: EXPOSURE_TYPE,
  });

  return {
    appId: input.appId,
    environmentId: input.environmentId,
    experimentId: input.ticket.experiment_id,
    runId: input.ticket.run_id,
    idType: input.ticket.id_type,
    targetingKeyHash: input.ticket.targeting_key_hash,
    entityFamilyHash: input.ticket.entity_family_hash,
    variantName: input.ticket.variant,
    type: EXPOSURE_TYPE,
    eventId: input.exposureId,
    dedupKey,
    sourceId: input.sourceId,
    counterfactual: false,
    isHoldover: false,
    clientTimestamp: input.clientTimestamp,
    exposureAt: serverReceivedAt,
    serverReceivedAt,
  };
}

interface ExposureDedupKeyInput {
  readonly appId: string;
  readonly eventId: string;
  readonly experimentId: string;
  readonly idType: string;
  readonly runId: string;
  readonly sourceId: string;
  readonly targetingKeyHash: string;
  readonly type: typeof EXPOSURE_TYPE;
}

async function exposureDedupKey(input: ExposureDedupKeyInput): Promise<string> {
  const material = [
    input.type,
    input.appId,
    input.experimentId,
    input.runId,
    input.idType,
    input.targetingKeyHash,
    input.sourceId,
    input.eventId,
  ].join(":");
  return `sha256:${await sha256Hex(material)}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
