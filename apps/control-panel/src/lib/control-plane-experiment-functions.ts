import { env as workerEnv } from "cloudflare:workers";
import {
  CreateExperimentRequestSchema,
  PatchExperimentRequestSchema,
  StartRunRequestSchema,
} from "@splitch/contracts";
import type { ExperimentsUpdateInput } from "@splitch/contracts/route-types";
import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import type {
  PanelExperimentDetailInput,
  PanelExperimentResultsInput,
  PanelExperimentsListInput,
} from "@splitch/control-plane-sdk/panel-experiments";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { controlPanelMutationBindings } from "./bindings";
import { createControlPanelExperimentsClient } from "./control-plane-experiments";
import { loadSessionFromRequest } from "./session-refresh";

export const loadControlPanelExperiments = createServerFn({ method: "GET" })
  .validator((data: PanelExperimentsListInput) => data)
  .handler(async ({ data }) => {
    const bindings = controlPanelMutationBindings(workerEnv);
    const loaded = await loadSessionFromRequest(bindings, getRequest());
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
    const loaded = await loadSessionFromRequest(bindings, getRequest());
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
    const loaded = await loadSessionFromRequest(bindings, getRequest());
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
  /**
   * A `confirm` Environment answers Start with the Approval Request the gate
   * opened. Dropping it here would let the Panel render a plain success for a
   * write that only landed because the operator was also its approver, which is
   * exactly the disguised default ADR-0036 forbids.
   *
   * Narrowed to id + status rather than passed through whole: the Approval
   * Request carries an untyped `diff` that a server function cannot prove
   * serializable, and the Panel only has to say WHICH gate ran. The reusable
   * confirm-gate surface is SPL-118's.
   */
  approvalRequest: { id: string; status: string } | null;
}>;

export const createControlPanelExperiment = createServerFn({ method: "POST" })
  .validator((data: unknown) => CreateExperimentRequestSchema.safeParse(data))
  .handler(async ({ data: parsed }): Promise<ExperimentMutationResult> => {
    if (!parsed.success) return validationError("The Experiment draft is malformed");
    const authorized = await authorizedExperimentsClient();
    if (!authorized.ok) return authorized.result;
    const result = await authorized.client.create(parsed.data);
    return result.ok
      ? { ok: true, status: result.status, data: { experimentId: result.data.id } }
      : result;
  });

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
            approvalRequest: result.data.approvalRequest
              ? {
                  id: result.data.approvalRequest.id,
                  status: result.data.approvalRequest.status,
                }
              : null,
          },
        }
      : result;
  });

async function authorizedExperimentsClient() {
  const bindings = controlPanelMutationBindings(workerEnv);
  const loaded = await loadSessionFromRequest(bindings, getRequest());
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
