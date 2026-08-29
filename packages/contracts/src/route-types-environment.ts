import type { z } from "@hono/zod-openapi";
import { EnvironmentSchema } from "./leaf-schemas-runtime";
import type { CreateEnvironmentResponseSchema } from "./resource-envelopes-account";
import type {
  AppParams,
  CanonicalEnvironmentSelectorQuerySchema,
  CreateEnvironmentRequestSchema,
  EnvParams,
  PatchEnvironmentRequestSchema,
} from "./routes/route-shapes";
import { listResponse } from "./wire-envelopes-core";

const EnvironmentListResponseSchema = listResponse(EnvironmentSchema);
type EnvironmentSelectorInput = z.infer<typeof CanonicalEnvironmentSelectorQuerySchema>;

export type EnvironmentsListInput = z.infer<typeof AppParams>;
export type EnvironmentsListOutput = z.infer<typeof EnvironmentListResponseSchema>;
export type EnvironmentsCreateInput = z.infer<typeof AppParams> &
  z.infer<typeof CreateEnvironmentRequestSchema>;
export type EnvironmentsCreateOutput = z.infer<typeof CreateEnvironmentResponseSchema>;
export type EnvironmentsGetInput = z.infer<typeof EnvParams> & EnvironmentSelectorInput;
export type EnvironmentsGetOutput = z.infer<typeof EnvironmentSchema>;
export type EnvironmentsUpdateInput = z.infer<typeof EnvParams> &
  z.infer<typeof PatchEnvironmentRequestSchema> &
  EnvironmentSelectorInput;
export type EnvironmentsUpdateOutput = z.infer<typeof EnvironmentSchema>;
export type EnvironmentsDeleteInput = z.infer<typeof EnvParams> & EnvironmentSelectorInput;
export type EnvironmentsDeleteOutput = { deleted: true };
