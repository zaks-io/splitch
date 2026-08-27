import {
  type Condition,
  type ConditionOperator,
  type CreateSegmentRequest,
  type PatchSegmentRequest,
  type Segment,
  SegmentSchema,
} from "@splitch/contracts";
import type { ControlPlaneOperationResult } from "./operation-result";
import { parseControlPlaneResponse } from "./operation-result";

/** Condition values the Panel may round-trip through server functions. */
export type PanelConditionValue = string | number | boolean | Array<string | number | boolean>;

export type PanelCondition = {
  attribute: string;
  operator: ConditionOperator;
  value: PanelConditionValue;
};

export type PanelSegment = Omit<Segment, "conditions"> & {
  conditions: PanelCondition[];
};

export type UnparseablePanelSegment = {
  id?: string;
  name?: string;
  reason: string;
};

export interface PanelSegmentsListInput {
  appId: string;
}

export type PanelSegmentCreateInput = CreateSegmentRequest & { appId: string };

export interface PanelSegmentGetInput {
  appId: string;
  segmentId: string;
}

export type PanelSegmentUpdateInput = PanelSegmentGetInput & PatchSegmentRequest;
export type PanelSegmentDeleteInput = PanelSegmentGetInput;

export interface PanelSegmentsListOutput {
  items: PanelSegment[];
  unparseable: UnparseablePanelSegment[];
  affectedEnvironmentIds: Record<string, string[]>;
  readLimit: number;
  readTruncated: boolean;
  cursor: string | null;
}

export interface PanelSegmentDeleteOutput {
  deleted: true;
}

export interface PanelSegmentsClient {
  list(
    input: PanelSegmentsListInput,
  ): Promise<ControlPlaneOperationResult<PanelSegmentsListOutput>>;
  create(input: PanelSegmentCreateInput): Promise<ControlPlaneOperationResult<PanelSegment>>;
  get(input: PanelSegmentGetInput): Promise<ControlPlaneOperationResult<PanelSegment>>;
  update(input: PanelSegmentUpdateInput): Promise<ControlPlaneOperationResult<PanelSegment>>;
  delete(
    input: PanelSegmentDeleteInput,
  ): Promise<ControlPlaneOperationResult<PanelSegmentDeleteOutput>>;
}

export function createPanelSegmentsClient(options: {
  fetch: typeof fetch;
  baseUrl?: string;
}): PanelSegmentsClient {
  const baseUrl = options.baseUrl ?? "https://control-plane.internal";
  const segmentUrl = (appId: string, segmentId?: string) =>
    new URL(
      `/apps/${encodeURIComponent(appId)}/segments${segmentId ? `/${encodeURIComponent(segmentId)}` : ""}`,
      baseUrl,
    );

  return {
    async list(input) {
      const response = await options.fetch(segmentUrl(input.appId));
      return parseControlPlaneResponse(response, "panel_segments_list", {
        safeParse: parseSegmentList,
      });
    },
    async create(input) {
      const { appId, ...body } = input;
      const response = await options.fetch(segmentUrl(appId), jsonRequest("POST", body));
      return parseControlPlaneResponse(response, "panel_segments_create", {
        safeParse: parseSegment,
      });
    },
    async get(input) {
      const response = await options.fetch(segmentUrl(input.appId, input.segmentId));
      return parseControlPlaneResponse(response, "panel_segments_get", {
        safeParse: parseSegment,
      });
    },
    async update(input) {
      const { appId, segmentId, ...patch } = input;
      const response = await options.fetch(
        segmentUrl(appId, segmentId),
        jsonRequest("PATCH", patch),
      );
      return parseControlPlaneResponse(response, "panel_segments_update", {
        safeParse: parseSegment,
      });
    },
    async delete(input) {
      const response = await options.fetch(segmentUrl(input.appId, input.segmentId), {
        method: "DELETE",
      });
      return parseControlPlaneResponse(response, "panel_segments_delete", {
        safeParse: parseDeleted,
      });
    },
  };
}

function jsonRequest(method: "POST" | "PATCH", body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function parseSegmentList(
  input: unknown,
): { success: true; data: PanelSegmentsListOutput } | { success: false } {
  if (!isListEnvelope(input)) return { success: false as const };
  const items: PanelSegment[] = [];
  const unparseable: UnparseablePanelSegment[] = [];
  const affectedEnvironmentIds: Record<string, string[]> = {};
  for (const raw of input.items) {
    const peeled = peelAffectedEnvironments(raw);
    const parsed = panelSegment(peeled.segment);
    if (parsed) {
      if (!peeled.affectedEnvironmentIds) return { success: false as const };
      items.push(parsed);
      affectedEnvironmentIds[parsed.id] = peeled.affectedEnvironmentIds;
      continue;
    }
    unparseable.push(unparseableSegment(raw));
    const id = segmentIdOf(raw);
    if (id) affectedEnvironmentIds[id] = peeled.affectedEnvironmentIds ?? [];
  }
  return {
    success: true,
    data: {
      items,
      unparseable,
      affectedEnvironmentIds,
      readLimit: input.readLimit,
      readTruncated: input.readTruncated,
      cursor: input.cursor,
    },
  };
}

function isListEnvelope(
  input: unknown,
): input is { items: unknown[]; readLimit: number; readTruncated: boolean; cursor: string | null } {
  return (
    isObject(input) &&
    Array.isArray(input.items) &&
    typeof input.readLimit === "number" &&
    typeof input.readTruncated === "boolean" &&
    (input.cursor === null || typeof input.cursor === "string")
  );
}

function peelAffectedEnvironments(raw: unknown): {
  segment: unknown;
  affectedEnvironmentIds: string[] | undefined;
} {
  if (!isObject(raw)) return { segment: raw, affectedEnvironmentIds: undefined };
  const { affectedEnvironmentIds, ...segment } = raw;
  return {
    segment,
    affectedEnvironmentIds: Array.isArray(affectedEnvironmentIds)
      ? affectedEnvironmentIds.every((id) => typeof id === "string")
        ? affectedEnvironmentIds
        : undefined
      : undefined,
  };
}

function segmentIdOf(raw: unknown): string | undefined {
  if (!isObject(raw)) return undefined;
  if (typeof raw.id === "string") return raw.id;
  if (typeof raw.id === "number") return String(raw.id);
  return undefined;
}

function parseSegment(input: unknown): { success: true; data: PanelSegment } | { success: false } {
  const parsed = panelSegment(input);
  return parsed ? { success: true, data: parsed } : { success: false };
}

function parseDeleted(
  input: unknown,
): { success: true; data: PanelSegmentDeleteOutput } | { success: false } {
  return isObject(input) && input.deleted === true
    ? { success: true, data: { deleted: true } }
    : { success: false };
}

function panelSegment(input: unknown): PanelSegment | null {
  const parsed = SegmentSchema.safeParse(input);
  if (!parsed.success) return null;
  try {
    return {
      ...parsed.data,
      conditions: parsed.data.conditions.map(panelCondition),
    };
  } catch {
    return null;
  }
}

function unparseableSegment(input: unknown): UnparseablePanelSegment {
  if (!isObject(input)) {
    return { reason: "Segment entry is not an object" };
  }
  return {
    ...(input.id !== undefined && input.id !== null ? { id: String(input.id) } : {}),
    ...(typeof input.name === "string" ? { name: input.name } : {}),
    reason: describeSegmentParseFailure(input),
  };
}

function describeSegmentParseFailure(input: Record<string, unknown>): string {
  const parsed = SegmentSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "segment";
      return `${path}: ${issue.message}`;
    }
    return "Segment failed schema validation";
  }
  return "Segment Condition values are not Panel-renderable scalars";
}

function panelCondition(condition: Condition): PanelCondition {
  return {
    attribute: condition.attribute,
    operator: condition.operator,
    value: panelConditionValue(condition.value),
  };
}

function panelConditionValue(value: Condition["value"]): PanelConditionValue {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      return entry;
    }
    throw new Error("Segment Condition list values must be string, number, or boolean");
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
