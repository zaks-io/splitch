import { env as workerEnv } from "cloudflare:workers";
import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import type {
  PanelSegment,
  PanelSegmentDeleteOutput,
  PanelSegmentsListOutput,
} from "@splitch/control-plane-sdk/panel-segments";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { controlPanelMutationBindings } from "#lib/shared/bindings";
import { createControlPanelSegmentsClient } from "#lib/segments/control-plane-segments";
import {
  SegmentDraftSchema,
  segmentCreateInput,
  segmentDraftIssues,
  segmentUpdateInput,
} from "#lib/segments/segment-form-model";
import { loadSessionFromRequest } from "#lib/sessions/session-refresh";

const SegmentScopeSchema = z.object({
  appId: z.string().min(1),
  environmentId: z.string().min(1),
});
const SegmentMutationSchema = SegmentScopeSchema.extend({
  segmentId: z.string().min(1).optional(),
  draft: SegmentDraftSchema,
});
const SegmentDeleteSchema = SegmentScopeSchema.extend({
  segmentId: z.string().min(1),
});

export const loadControlPanelSegments = createServerFn({ method: "GET" })
  .validator((data: unknown) => SegmentScopeSchema.safeParse(data))
  .handler(
    async ({ data: parsed }): Promise<ControlPlaneOperationResult<PanelSegmentsListOutput>> => {
      if (!parsed.success) return malformed("The Segment scope is malformed");
      const authorized = await authorizedSegmentsClient(parsed.data.environmentId);
      if (!authorized.ok) return authorized.result;
      return authorized.segments.list({ appId: parsed.data.appId });
    },
  );

export const saveControlPanelSegment = createServerFn({ method: "POST" })
  .validator((data: unknown) => SegmentMutationSchema.safeParse(data))
  .handler(async ({ data: parsed }): Promise<ControlPlaneOperationResult<PanelSegment>> => {
    if (!parsed.success) return malformed("The Segment draft is malformed");
    const { appId, environmentId, segmentId, draft } = parsed.data;
    const issues = segmentDraftIssues(draft);
    if (issues.length > 0) {
      return {
        ok: false,
        status: 400,
        error: {
          code: "VALIDATION_ERROR",
          message: "The Segment draft is incomplete",
          details: {
            issues: issues.map((issue) => ({
              path: ["body", ...issue.path.split(".")],
              message: issue.message,
            })),
          },
        },
      };
    }
    const authorized = await authorizedSegmentsClient(environmentId);
    if (!authorized.ok) return authorized.result;
    return segmentId
      ? authorized.segments.update({ appId, segmentId, ...segmentUpdateInput(draft) })
      : authorized.segments.create({ appId, ...segmentCreateInput(draft) });
  });

export const deleteControlPanelSegment = createServerFn({ method: "POST" })
  .validator((data: unknown) => SegmentDeleteSchema.safeParse(data))
  .handler(
    async ({ data: parsed }): Promise<ControlPlaneOperationResult<PanelSegmentDeleteOutput>> => {
      if (!parsed.success) return malformed("The Segment delete request is malformed");
      const authorized = await authorizedSegmentsClient(parsed.data.environmentId);
      if (!authorized.ok) return authorized.result;
      return authorized.segments.delete({
        appId: parsed.data.appId,
        segmentId: parsed.data.segmentId,
      });
    },
  );

async function authorizedSegmentsClient(environmentId: string) {
  const bindings = controlPanelMutationBindings(workerEnv);
  const loaded = await loadSessionFromRequest(bindings, getRequest());
  if (!loaded.ok) {
    return {
      ok: false as const,
      result: {
        ok: false as const,
        status: 401,
        error: { code: "UNAUTHORIZED" as const, message: "authentication required", details: {} },
      },
    };
  }
  return {
    ok: true as const,
    segments: createControlPanelSegmentsClient(
      bindings.CONTROL_PLANE_API,
      { actorId: loaded.session.userId, sessionExpiresAt: loaded.session.expiresAt },
      environmentId,
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ),
  };
}

function malformed<T>(message: string): ControlPlaneOperationResult<T> {
  return {
    ok: false,
    status: 400,
    error: { code: "VALIDATION_ERROR", message, details: { issues: [] } },
  };
}
