import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import type {
  PanelExperimentRouteResolutionInput,
  PanelExperimentRouteResolutionOutput,
} from "@splitch/control-plane-sdk/panel-experiments";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authorizedExperimentsClient } from "#lib/auth/panel-authorized-clients";

const ResolutionInputSchema = z.object({
  appId: z.string().min(1),
  targetEnvironmentId: z.string().min(1),
  experimentRef: z.string().min(1),
  runId: z.string().min(1).optional(),
});

export type ExperimentEnvironmentResolution = PanelExperimentRouteResolutionOutput;
type ResolutionResult = ControlPlaneOperationResult<PanelExperimentRouteResolutionOutput>;

export const resolveControlPanelExperimentEnvironment = createServerFn({ method: "GET" })
  .validator((data: unknown) => ResolutionInputSchema.safeParse(data))
  .handler(async ({ data: parsed }): Promise<ResolutionResult> => {
    if (!parsed.success) return validationError("The Experiment route scope is malformed");
    const authorized = await authorizedExperimentsClient();
    if (!authorized.ok) return authorized.result;
    return authorized.client.resolveRoute(
      parsed.data satisfies PanelExperimentRouteResolutionInput,
    );
  });

function validationError(message: string): ResolutionResult {
  return {
    ok: false,
    status: 400,
    error: {
      code: "VALIDATION_ERROR",
      message,
      details: { issues: [{ path: ["route"], message }] },
    },
  };
}
