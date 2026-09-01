import { z } from "zod";

export type PanelExperimentRouteResolutionInput = {
  appId: string;
  targetEnvironmentId: string;
  experimentRef: string;
  runId?: string;
};

const ResolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("experiment"), experimentId: z.string(), experimentKey: z.string() }),
  z.object({ kind: z.literal("experiment_not_found") }),
  z.object({ kind: z.literal("experiment_not_in_environment"), experimentKey: z.string() }),
  z.object({ kind: z.literal("run_not_found"), experimentKey: z.string() }),
  z.object({
    kind: z.literal("run_elsewhere"),
    env: z.string(),
    experimentId: z.string(),
    experimentKey: z.string(),
    runId: z.string(),
  }),
]);

export type PanelExperimentRouteResolutionOutput = z.infer<typeof ResolutionSchema>;
export function parsePanelExperimentRouteResolutionOutput(input: unknown) {
  return ResolutionSchema.safeParse(input);
}
