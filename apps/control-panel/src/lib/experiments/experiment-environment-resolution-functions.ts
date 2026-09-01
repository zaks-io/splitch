import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import type {
  PanelExperimentListItem,
  PanelExperimentsListInput,
  PanelExperimentsListOutput,
} from "@splitch/control-plane-sdk/panel-experiments";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authorizedExperimentsClient } from "#lib/auth/panel-authorized-clients";
import {
  type ExperimentDetailReader,
  type ExperimentEnvironmentResolution,
  resolveExperimentEnvironmentFromCatalogs,
} from "#lib/experiments/experiment-environment-resolution";

const EnvironmentSchema = z.object({
  environmentId: z.string().min(1),
  env: z.string().min(1),
});

const ResolutionInputSchema = z.object({
  appId: z.string().min(1),
  targetEnvironmentId: z.string().min(1),
  environments: z.array(EnvironmentSchema).min(1),
  experimentRef: z.string().min(1),
  runId: z.string().min(1).optional(),
});

type Environment = z.infer<typeof EnvironmentSchema>;
type ResolutionInput = z.infer<typeof ResolutionInputSchema>;
type ExperimentsClient = ExperimentDetailReader & {
  list(
    input: PanelExperimentsListInput,
  ): Promise<ControlPlaneOperationResult<PanelExperimentsListOutput>>;
};
type Catalog = { environment: Environment; items: PanelExperimentListItem[] };

export type { ExperimentEnvironmentResolution } from "#lib/experiments/experiment-environment-resolution";

type ResolutionResult = ControlPlaneOperationResult<ExperimentEnvironmentResolution>;

export const resolveControlPanelExperimentEnvironment = createServerFn({ method: "GET" })
  .validator((data: unknown) => ResolutionInputSchema.safeParse(data))
  .handler(async ({ data: parsed }): Promise<ResolutionResult> => {
    if (!parsed.success) return validationError("The Experiment route scope is malformed");
    const input = parsed.data;
    assertEnvironmentScope(input.environments, input.targetEnvironmentId);

    const authorized = await authorizedExperimentsClient();
    if (!authorized.ok) return authorized.result;

    const catalogs = await loadCatalogs(authorized.client, input);
    if (!catalogs.ok) return catalogs;
    return resolveExperimentEnvironmentFromCatalogs(authorized.client, input, catalogs.data);
  });

async function loadCatalogs(
  client: ExperimentsClient,
  input: ResolutionInput,
): Promise<ControlPlaneOperationResult<Catalog[]>> {
  const results = await Promise.all(
    input.environments.map(async (environment) => ({
      environment,
      result: await client.list({
        appId: input.appId,
        environmentId: environment.environmentId,
      }),
    })),
  );
  const failure = results.find(({ result }) => !result.ok)?.result;
  if (failure && !failure.ok) return failure;
  return operationSuccess(
    results.map(({ environment, result }) => {
      if (!result.ok) throw new Error("Experiment catalog failed after failure handling");
      return { environment, items: result.data.items };
    }),
  );
}

function assertEnvironmentScope(environments: Environment[], targetEnvironmentId: string) {
  if (!environments.some((environment) => environment.environmentId === targetEnvironmentId)) {
    throw new Error("Target Environment is absent from App navigation");
  }
  if (
    new Set(environments.map((environment) => environment.environmentId)).size !==
    environments.length
  ) {
    throw new Error("App navigation contains duplicate Environments");
  }
}

function operationSuccess<T>(data: T): ControlPlaneOperationResult<T> {
  return { ok: true, status: 200, data };
}

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
