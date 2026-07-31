import { env as workerEnv } from "cloudflare:workers";
import type {
  PanelExperimentDetailInput,
  PanelExperimentResultsInput,
  PanelExperimentsListInput,
} from "@splitch/control-plane-sdk/panel-experiments";
import { PatchExperimentRequestSchema, StartRunRequestSchema } from "@splitch/contracts";
import type { ExperimentsUpdateInput } from "@splitch/contracts/route-types";
import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { controlPanelMutationBindings } from "./bindings";
import { createControlPanelExperimentsClient } from "./control-plane-experiments";
import { loadSessionFromRequest } from "./session";

export const loadControlPanelExperiments = createServerFn({ method: "GET" })
  .validator((data: PanelExperimentsListInput) => data)
  .handler(async ({ data }) => {
    const bindings = controlPanelMutationBindings(workerEnv);
    const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, getRequest());
    if (!loaded.ok) {
      return {
        ok: false as const,
        status: 401,
        error: { code: "UNAUTHORIZED", message: "authentication required", details: {} },
      };
    }
    return createControlPanelExperimentsClient(
      bindings.CONTROL_PLANE_API,
      { actorId: loaded.session.userId, sessionExpiresAt: loaded.session.expiresAt },
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ).list(data);
  });

export const loadControlPanelExperimentDetail = createServerFn({ method: "GET" })
  .validator((data: PanelExperimentDetailInput) => data)
  .handler(async ({ data }) => {
    const bindings = controlPanelMutationBindings(workerEnv);
    const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, getRequest());
    if (!loaded.ok) {
      return {
        ok: false as const,
        status: 401,
        error: { code: "UNAUTHORIZED", message: "authentication required", details: {} },
      };
    }
    return createControlPanelExperimentsClient(
      bindings.CONTROL_PLANE_API,
      { actorId: loaded.session.userId, sessionExpiresAt: loaded.session.expiresAt },
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ).detail(data);
  });

export const loadControlPanelExperimentResults = createServerFn({ method: "GET" })
  .validator((data: PanelExperimentResultsInput) => data)
  .handler(async ({ data }) => {
    const bindings = controlPanelMutationBindings(workerEnv);
    const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, getRequest());
    if (!loaded.ok) {
      return {
        ok: false as const,
        status: 401,
        error: { code: "UNAUTHORIZED", message: "authentication required", details: {} },
      };
    }
    return createControlPanelExperimentsClient(
      bindings.CONTROL_PLANE_API,
      { actorId: loaded.session.userId, sessionExpiresAt: loaded.session.expiresAt },
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ).results(data);
  });

const ExperimentMutationScopeSchema = z.object({
  appId: z.string().min(1),
  environmentId: z.string().min(1),
  experimentId: z.string().min(1),
});

const UpdateExperimentInputSchema = ExperimentMutationScopeSchema.extend({
  patch: PatchExperimentRequestSchema,
});

const StageAndStartRunInputSchema = ExperimentMutationScopeSchema.extend({
  draft: PatchExperimentRequestSchema,
  start: StartRunRequestSchema,
});

type ExperimentMutationResult = ControlPlaneOperationResult<{ experimentId: string }>;
type RunStartResult = ControlPlaneOperationResult<{
  experimentId: string;
  previousRunId: string | null;
  runId: string;
}>;

export const updateControlPanelExperiment = createServerFn({ method: "POST" })
  .validator((data: unknown) => UpdateExperimentInputSchema.safeParse(data))
  .handler(async ({ data: parsed }): Promise<ExperimentMutationResult> => {
    if (!parsed.success) return validationError("The Experiment edit is malformed");
    const authorized = await authorizedExperimentsClient();
    if (!authorized.ok) return authorized.result;
    const { patch, ...scope } = parsed.data;
    const result = await authorized.client.update({
      ...scope,
      ...patch,
    } as ExperimentsUpdateInput);
    return result.ok
      ? {
          ok: true,
          status: result.status,
          data: { experimentId: result.data.id },
        }
      : result;
  });

/** Shared draft → Start mechanism for Run 1 and every later Experiment Run. */
export const stageAndStartControlPanelExperimentRun = createServerFn({ method: "POST" })
  .validator((data: unknown) => StageAndStartRunInputSchema.safeParse(data))
  .handler(async ({ data: parsed }): Promise<RunStartResult> => {
    if (!parsed.success) return validationError("The Experiment Run draft is malformed");
    const authorized = await authorizedExperimentsClient();
    if (!authorized.ok) return authorized.result;
    const { draft, start, ...scope } = parsed.data;
    const staged = await authorized.client.update({
      ...scope,
      ...draft,
      stageForNextRun: true,
    } as ExperimentsUpdateInput);
    if (!staged.ok) return staged;
    const result = await authorized.client.start({ ...scope, ...start });
    return result.ok
      ? {
          ok: true,
          status: result.status,
          data: {
            experimentId: result.data.experimentId,
            previousRunId: result.data.previousRunId,
            runId: result.data.run.id,
          },
        }
      : result;
  });

async function authorizedExperimentsClient() {
  const bindings = controlPanelMutationBindings(workerEnv);
  const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, getRequest());
  if (!loaded.ok) {
    return {
      ok: false as const,
      result: {
        ok: false as const,
        status: 401,
        error: {
          code: "UNAUTHORIZED" as const,
          message: "authentication required",
          details: {},
        },
      },
    };
  }
  return {
    ok: true as const,
    client: createControlPanelExperimentsClient(
      bindings.CONTROL_PLANE_API,
      { actorId: loaded.session.userId, sessionExpiresAt: loaded.session.expiresAt },
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ),
  };
}

function validationError(message: string): ControlPlaneOperationResult<never> {
  return {
    ok: false,
    status: 400,
    error: {
      code: "VALIDATION_ERROR",
      message,
      details: { issues: [{ path: ["body"], message }] },
    },
  };
}
