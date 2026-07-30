import { VariantSchema } from "@splitch/contracts";

export interface PanelExperimentDetailInput {
  appId: string;
  environmentId: string;
  experimentId: string;
}

export interface PanelExperimentRun {
  id: string;
  experimentId: string;
  environmentId: string;
  runNumber: number;
  status: "ended" | "running";
  targetingKey: string;
  targetingKeyType: string;
  salt: string;
  allocation: Record<string, number>;
  variantsJson: string;
  targetingRulesJson: string;
  configHash: string;
  startedAt: string;
  endedAt: string | null;
  startReason: string | null;
  endReason: string | null;
  createdAt: string;
}

export interface PanelExperimentDetail {
  id: string;
  name: string;
  status: "draft" | "running" | "ended";
  flagId: string;
  liveRunId: string | null;
}

export interface PanelExperimentDetailOutput {
  experiment: PanelExperimentDetail;
  flag: { id: string; name: string };
  runs: PanelExperimentRun[];
}

export function parsePanelExperimentDetailOutput(input: unknown) {
  if (!isObject(input) || !isObject(input.flag) || !Array.isArray(input.runs)) {
    return { success: false as const };
  }
  const experiment = parsePanelExperimentDetail(input.experiment);
  const runs = input.runs.map(parsePanelExperimentRun);
  if (
    experiment === null ||
    !isNonEmptyString(input.flag.id) ||
    !isNonEmptyString(input.flag.name) ||
    runs.some((run) => run === null)
  ) {
    return { success: false as const };
  }
  return {
    success: true as const,
    data: {
      experiment,
      flag: { id: input.flag.id, name: input.flag.name },
      runs,
    } as PanelExperimentDetailOutput,
  };
}

function parsePanelExperimentRun(input: unknown): PanelExperimentRun | null {
  if (
    !isObject(input) ||
    !isNonEmptyString(input.id) ||
    !isNonEmptyString(input.experimentId) ||
    !isNonEmptyString(input.environmentId) ||
    !Number.isInteger(input.runNumber) ||
    Number(input.runNumber) < 1 ||
    !isRunStatus(input.status) ||
    !isNonEmptyString(input.targetingKey) ||
    !isNonEmptyString(input.targetingKeyType) ||
    !isNonEmptyString(input.salt) ||
    !isAllocation(input.allocation) ||
    !isVariantArrayJson(input.variantsJson) ||
    !isJsonArray(input.targetingRulesJson) ||
    !isNonEmptyString(input.configHash) ||
    !isNonEmptyString(input.startedAt) ||
    !isOptionalString(input.endedAt) ||
    !isOptionalString(input.startReason) ||
    !isOptionalString(input.endReason) ||
    !isNonEmptyString(input.createdAt)
  ) {
    return null;
  }
  return {
    id: input.id,
    experimentId: input.experimentId,
    environmentId: input.environmentId,
    runNumber: Number(input.runNumber),
    status: input.status,
    targetingKey: input.targetingKey,
    targetingKeyType: input.targetingKeyType,
    salt: input.salt,
    allocation: input.allocation,
    variantsJson: input.variantsJson,
    targetingRulesJson: input.targetingRulesJson,
    configHash: input.configHash,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    startReason: input.startReason,
    endReason: input.endReason,
    createdAt: input.createdAt,
  };
}

function parsePanelExperimentDetail(input: unknown): PanelExperimentDetail | null {
  if (
    !isObject(input) ||
    !isNonEmptyString(input.id) ||
    !isNonEmptyString(input.name) ||
    !isLifecycle(input.status) ||
    !isNonEmptyString(input.flagId) ||
    !(input.liveRunId === null || isNonEmptyString(input.liveRunId))
  ) {
    return null;
  }
  return {
    id: input.id,
    name: input.name,
    status: input.status,
    flagId: input.flagId,
    liveRunId: input.liveRunId,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isRunStatus(value: unknown): value is PanelExperimentRun["status"] {
  return value === "ended" || value === "running";
}

function isAllocation(value: unknown): value is Record<string, number> {
  return (
    isObject(value) &&
    Object.values(value).every((share) => typeof share === "number" && Number.isFinite(share))
  );
}

function isVariantArrayJson(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => VariantSchema.safeParse(item).success);
  } catch {
    return false;
  }
}

function isJsonArray(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
}

function isLifecycle(value: unknown): value is PanelExperimentDetail["status"] {
  return value === "draft" || value === "running" || value === "ended";
}
