import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { draftIssues, FlagDraftSchema, flagCreateInput } from "./create-flag-model";
import { type FlagDetailNotFound, isFlagDetailNotFound, readFlagDetail } from "./flag-detail-data";
import { type FlagDetailView, flagDetailView } from "./flag-detail-view";
import { type FlagsPageData, readFlagsPage } from "./flags-page-data";
import { authorizedFlagsClient, authorizedSegmentsClient } from "./panel-authorized-clients";

type FlagsPageScope = { appId: string; environmentId: string };
type CreateFlagResult = ControlPlaneOperationResult<{ key: string }>;

const CreateFlagInputSchema = z.object({
  appId: z.string(),
  environmentId: z.string(),
  draft: FlagDraftSchema,
  /**
   * Carried from the browser rather than minted here: a key minted per handler
   * invocation is fresh on every retry, so it would give the Control Plane no
   * way to recognize a replay of the same submission.
   */
  idempotencyKey: z.string().min(1),
});

export const loadControlPanelFlags = createServerFn({ method: "GET" })
  .validator((data: FlagsPageScope) => data)
  .handler(async ({ data }): Promise<ControlPlaneOperationResult<FlagsPageData>> => {
    const authorized = await authorizedFlagsClient(data.environmentId);
    if (!authorized.ok) return authorized.result;
    return readFlagsPage(authorized.client, data);
  });

/**
 * Reads BOTH grains of the Flag detail screen in the Worker and hands the panel one
 * already-resolved view model, so the browser never merges App-level definition
 * with per-Environment Configuration itself. The derivation runs here, not in the
 * component, which is also why only primitives cross the wire.
 */
export const loadControlPanelFlagDetail = createServerFn({ method: "GET" })
  .validator((data: FlagsPageScope & { env: string; flagKey: string }) => data)
  .handler(
    async ({ data }): Promise<ControlPlaneOperationResult<FlagDetailView | FlagDetailNotFound>> => {
      const authorized = await authorizedFlagsClient(data.environmentId);
      if (!authorized.ok) return authorized.result;
      const detail = await readFlagDetail(authorized.client, data, data.flagKey);
      if (!detail.ok) return detail;
      if (isFlagDetailNotFound(detail.data)) {
        return { ok: true, status: detail.status, data: detail.data };
      }
      if (detail.data.configuration === null) {
        return {
          ok: true,
          status: detail.status,
          data: flagDetailView(detail.data, data.env, {
            items: [],
            unparseable: [],
            affectedEnvironmentIds: {},
          }),
        };
      }
      const segments = await authorizedSegmentsClient(data.environmentId);
      if (!segments.ok) return segments.result;
      const segmentList = await segments.client.list({ appId: data.appId });
      if (!segmentList.ok) return segmentList;
      return {
        ok: true,
        status: detail.status,
        data: flagDetailView(detail.data, data.env, segmentList.data),
      };
    },
  );

export const createControlPanelFlag = createServerFn({ method: "POST" })
  // Parsed, not cast: an unauthenticated caller can reach this, and a malformed
  // body must fail as a 400 rather than throwing a 500 downstream (ADR-0036).
  .validator((data: unknown) => CreateFlagInputSchema.safeParse(data))
  .handler(async ({ data: parsed }): Promise<CreateFlagResult> => {
    if (!parsed.success) {
      return validationError(
        "The Flag draft is malformed",
        parsed.error.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message,
        })),
      );
    }
    const data = parsed.data;

    // The client validates to render inline errors; the server revalidates
    // because the draft arrives over the wire and is not trusted.
    const issues = draftIssues(data.draft);
    if (issues.length > 0) {
      return validationError(
        "The Flag draft is incomplete",
        issues.map((issue) => ({ path: issue.path.split("."), message: issue.message })),
      );
    }

    const authorized = await authorizedFlagsClient(data.environmentId);
    if (!authorized.ok) return authorized.result;
    const result = await authorized.client.create(
      flagCreateInput(data.appId, data.draft, data.idempotencyKey),
    );
    return result.ok ? { ok: true, status: result.status, data: { key: result.data.key } } : result;
  });

function validationError(
  message: string,
  issues: Array<{ path: string[]; message: string }>,
): CreateFlagResult {
  return {
    ok: false,
    status: 400,
    error: { code: "VALIDATION_ERROR", message, details: { issues } },
  };
}
