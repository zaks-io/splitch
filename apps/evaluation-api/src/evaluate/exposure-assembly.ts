import type { ExposureEvent } from "@splitch/contracts";
import { computeTargetingKeyHash, type SaltStore } from "@splitch/privacy";
import type { EvaluatePathInput, EvaluateResult } from "./evaluate-path-types";

const EXPOSURE_TYPE = "exposure" as const;

export interface ExposureAssemblyDeps {
  readonly saltStore: SaltStore;
  readonly sourceId: string;
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

  const timestamp = (deps.now ?? (() => new Date()))().toISOString();
  const eventId = (deps.newEventId ?? (() => crypto.randomUUID()))();
  const targetingKeyHash = await computeTargetingKeyHash(deps.saltStore, {
    appId: input.appId,
    idType: result.exposure.idType,
    targetingKey: input.evaluationContext.targetingKey,
  });
  const runId = result.liveRunId;
  const dedupKey = await exposureDedupKey({
    appId: input.appId,
    eventId,
    experimentId: result.exposure.experimentId,
    idType: result.exposure.idType,
    runId,
    sourceId: deps.sourceId,
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
      variantName: result.exposure.variant,
      type: EXPOSURE_TYPE,
      eventId,
      dedupKey,
      sourceId: deps.sourceId,
      counterfactual: false,
      isHoldover: false,
      clientTimestamp: timestamp,
      serverReceivedAt: timestamp,
      ingestTs: timestamp,
    },
  ];
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
