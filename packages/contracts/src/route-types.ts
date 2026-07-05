import { z } from "@hono/zod-openapi";
import {
  type CreateExperimentRequestSchema,
  ExperimentResponseSchema,
  type PatchExperimentRequestSchema,
  RunResponseSchema,
  type StartRunRequestSchema,
} from "./resource-envelopes-experiment";
import {
  type CreateFlagRequestSchema,
  FlagResponseSchema,
  type PatchFlagRequestSchema,
} from "./resource-envelopes-flag";
import type { AppParams, EnvParams, ExperimentParams, FlagParams } from "./routes/route-shapes";

/**
 * Typed flat inputs/outputs for representative Control Plane operations.
 * These compose the same Zod schemas the route registry uses — no parallel request
 * shapes in the SDK.
 */

const FlagListResponseSchema = z.object({ items: z.array(FlagResponseSchema) });
const ExperimentListResponseSchema = z.object({ items: z.array(ExperimentResponseSchema) });
const StartRunResponseSchema = z.object({
  experimentId: z.string(),
  run: RunResponseSchema,
  previousRunId: z.string().nullable(),
});
const DeletedResponseSchema = z.object({ deleted: z.literal(true) });

export type FlagsListInput = z.infer<typeof AppParams>;
export type FlagsListOutput = z.infer<typeof FlagListResponseSchema>;
export type FlagsCreateInput = z.infer<typeof AppParams> & z.infer<typeof CreateFlagRequestSchema>;
export type FlagsCreateOutput = z.infer<typeof FlagResponseSchema>;
export type FlagsGetInput = z.infer<typeof FlagParams>;
export type FlagsGetOutput = z.infer<typeof FlagResponseSchema>;
export type FlagsUpdateInput = z.infer<typeof FlagParams> & z.infer<typeof PatchFlagRequestSchema>;
export type FlagsUpdateOutput = z.infer<typeof FlagResponseSchema>;
export type FlagsDeleteInput = z.infer<typeof FlagParams>;
export type FlagsDeleteOutput = z.infer<typeof DeletedResponseSchema>;

export type ExperimentsListInput = z.infer<typeof EnvParams>;
export type ExperimentsListOutput = z.infer<typeof ExperimentListResponseSchema>;
export type ExperimentsCreateInput = z.infer<typeof EnvParams> &
  z.infer<typeof CreateExperimentRequestSchema>;
export type ExperimentsCreateOutput = z.infer<typeof ExperimentResponseSchema>;
export type ExperimentsGetInput = z.infer<typeof ExperimentParams>;
export type ExperimentsGetOutput = z.infer<typeof ExperimentResponseSchema>;
export type ExperimentsUpdateInput = z.infer<typeof ExperimentParams> &
  z.infer<typeof PatchExperimentRequestSchema>;
export type ExperimentsUpdateOutput = z.infer<typeof ExperimentResponseSchema>;
export type ExperimentsStartInput = z.infer<typeof ExperimentParams> &
  z.infer<typeof StartRunRequestSchema>;
export type ExperimentsStartOutput = z.infer<typeof StartRunResponseSchema>;
export type ExperimentsDeleteInput = z.infer<typeof ExperimentParams>;
export type ExperimentsDeleteOutput = z.infer<typeof DeletedResponseSchema>;

export type OperationId =
  | "flags_list"
  | "flags_create"
  | "flags_get"
  | "flags_update"
  | "flags_delete"
  | "experiments_list"
  | "experiments_create"
  | "experiments_get"
  | "experiments_update"
  | "experiments_start"
  | "experiments_delete";

export type RouteFlatInput<Op extends OperationId> = Op extends "flags_list"
  ? FlagsListInput
  : Op extends "flags_create"
    ? FlagsCreateInput
    : Op extends "flags_get"
      ? FlagsGetInput
      : Op extends "flags_update"
        ? FlagsUpdateInput
        : Op extends "flags_delete"
          ? FlagsDeleteInput
          : Op extends "experiments_list"
            ? ExperimentsListInput
            : Op extends "experiments_create"
              ? ExperimentsCreateInput
              : Op extends "experiments_get"
                ? ExperimentsGetInput
                : Op extends "experiments_update"
                  ? ExperimentsUpdateInput
                  : Op extends "experiments_start"
                    ? ExperimentsStartInput
                    : Op extends "experiments_delete"
                      ? ExperimentsDeleteInput
                      : never;

export type RouteOutput<Op extends OperationId> = Op extends "flags_list"
  ? FlagsListOutput
  : Op extends "flags_create"
    ? FlagsCreateOutput
    : Op extends "flags_get"
      ? FlagsGetOutput
      : Op extends "flags_update"
        ? FlagsUpdateOutput
        : Op extends "flags_delete"
          ? FlagsDeleteOutput
          : Op extends "experiments_list"
            ? ExperimentsListOutput
            : Op extends "experiments_create"
              ? ExperimentsCreateOutput
              : Op extends "experiments_get"
                ? ExperimentsGetOutput
                : Op extends "experiments_update"
                  ? ExperimentsUpdateOutput
                  : Op extends "experiments_start"
                    ? ExperimentsStartOutput
                    : Op extends "experiments_delete"
                      ? ExperimentsDeleteOutput
                      : never;

export type RouteInput<Op extends OperationId> = RouteFlatInput<Op>;
