import { env as workerEnv } from "cloudflare:workers";
import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import { createRepository } from "@splitch/db";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { controlPanelBindings } from "./bindings";
import { draftIssues, FlagDraftSchema, flagCreateInput } from "./create-flag-model";
import { type FlagDetailNotFound, isFlagDetailNotFound, readFlagDetail } from "./flag-detail-data";
import { type FlagDetailView, flagDetailView } from "./flag-detail-view";
import {
  assertMatrixEnvironments,
  type FlagsMatrixData,
  readFlagsMatrix,
} from "./flags-matrix-data";
import { type FlagsPageData, readFlagsPage } from "./flags-page-data";
import { createEnvironmentResolver } from "./membership";
import {
  authorizedFlagDetailClients,
  authorizedFlagsClient,
  authorizedFlagsClients,
} from "./panel-authorized-clients";

type FlagsPageScope = { appId: string; environmentId: string };
type FlagsMatrixScope = { appId: string; environmentIds: string[] };
export type CreatedFlagHandoff = {
  key: string;
  defaultVariantId: string;
  variants: Array<{ id: string; name: string; valueJson: string }>;
};
type CreateFlagResult = ControlPlaneOperationResult<CreatedFlagHandoff>;

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

export const loadControlPanelFlagsMatrix = createServerFn({ method: "GET" })
  .validator((data: FlagsMatrixScope) => data)
  .handler(async ({ data }): Promise<ControlPlaneOperationResult<FlagsMatrixData>> => {
    const authorized = await authorizedFlagsClients(data.environmentIds);
    if (!authorized.ok) return authorized.result;
    const repo = createRepository(controlPanelBindings(workerEnv).DB);
    const environments = await createEnvironmentResolver(repo).listEnvironments(data.appId);
    assertMatrixEnvironments(data.environmentIds, environments);

    return readFlagsMatrix(authorized.client, data.appId);
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
      const authorized = await authorizedFlagDetailClients(data.environmentId);
      if (!authorized.ok) return authorized.result;
      const detail = await readFlagDetail(authorized.client.flags, data, data.flagKey);
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
            readLimit: 200,
            readTruncated: false,
            cursor: null,
          }),
        };
      }
      const segmentList = await authorized.client.segments.list({ appId: data.appId });
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

    const authorized = await authorizedFlagsClient(data.environmentId);
    if (!authorized.ok) return authorized.result;

    // The client validates to render inline errors; the server revalidates
    // because the draft arrives over the wire and is not trusted. This runs
    // after authorization: schema conformance compiles caller-supplied
    // regexes, and that CPU must not be spendable by an unauthenticated body.
    const issues = draftIssues(data.draft);
    if (issues.length > 0) {
      return validationError(
        "The Flag draft is incomplete",
        issues.map((issue) => ({ path: issue.path.split("."), message: issue.message })),
      );
    }
    const result = await authorized.client.create(
      flagCreateInput(data.appId, data.draft, data.idempotencyKey),
    );
    return result.ok
      ? {
          ok: true,
          status: result.status,
          data: {
            key: result.data.key,
            defaultVariantId: result.data.defaultVariantId,
            variants: result.data.variants.map(({ id, name, value }) => ({
              id,
              name,
              valueJson: JSON.stringify(value),
            })),
          },
        }
      : result;
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
