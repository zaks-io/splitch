/**
 * The Experiment list projection the Panel renders, and its hand-rolled parser.
 *
 * Hand-rolled rather than Zod because this is the SDK's read boundary: an
 * unparseable list must degrade to a typed `success: false`, never to a
 * half-populated row that renders as a healthy Experiment.
 */

export interface PanelExperimentsListInput {
  appId: string;
  environmentId: string;
}

export interface PanelExperimentHealth {
  significanceReached: boolean;
  srmFiring: boolean;
  guardrailBreached: boolean;
}

export interface PanelExperimentListItem {
  id: string;
  /** Stable Experiment identity shared by corresponding rows across Environments. */
  key: string;
  name: string;
  status: "draft" | "running" | "ended";
  flag: { id: string; name: string };
  liveRunId: string | null;
  /** Whether any Run has ever been opened; a `draft` Experiment may be a former one. */
  hasRuns: boolean;
  health: PanelExperimentHealth | null;
}

export interface PanelExperimentsListOutput {
  items: PanelExperimentListItem[];
}

export function parsePanelExperimentsListOutput(input: unknown) {
  if (!isObject(input) || !Array.isArray(input.items)) return { success: false as const };
  const items = input.items.map(parsePanelExperimentItem);
  if (items.some((item) => item === null)) return { success: false as const };
  return { success: true as const, data: { items } as PanelExperimentsListOutput };
}

function parsePanelExperimentItem(input: unknown): PanelExperimentListItem | null {
  if (!isObject(input) || !isObject(input.flag)) return null;
  if (
    !isNonEmptyString(input.id) ||
    !isNonEmptyString(input.key) ||
    !isNonEmptyString(input.name) ||
    !isLifecycle(input.status) ||
    !isNonEmptyString(input.flag.id) ||
    !isNonEmptyString(input.flag.name) ||
    !(input.liveRunId === null || isNonEmptyString(input.liveRunId)) ||
    typeof input.hasRuns !== "boolean"
  ) {
    return null;
  }
  const health = parseHealth(input.health);
  if (input.health !== null && health === null) return null;
  return {
    id: input.id,
    key: input.key,
    name: input.name,
    status: input.status,
    flag: { id: input.flag.id, name: input.flag.name },
    liveRunId: input.liveRunId,
    hasRuns: input.hasRuns,
    health,
  };
}

function parseHealth(input: unknown): PanelExperimentHealth | null {
  if (input === null) return null;
  if (
    !isObject(input) ||
    typeof input.significanceReached !== "boolean" ||
    typeof input.srmFiring !== "boolean" ||
    typeof input.guardrailBreached !== "boolean"
  ) {
    return null;
  }
  return {
    significanceReached: input.significanceReached,
    srmFiring: input.srmFiring,
    guardrailBreached: input.guardrailBreached,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isLifecycle(value: unknown): value is PanelExperimentListItem["status"] {
  return value === "draft" || value === "running" || value === "ended";
}
