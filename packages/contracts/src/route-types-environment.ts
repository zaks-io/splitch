import type { z } from "@hono/zod-openapi";
import { type ClientKeySchema, EnvironmentSchema } from "./leaf-schemas-runtime";
import type {
  CreateCredentialResponseSchema,
  CreateEnvironmentResponseSchema,
  ListCredentialsResponseSchema,
} from "./resource-envelopes-account";
import {
  type CreateExperimentRequestSchema,
  ExperimentResponseSchema,
  type ExperimentUpdateResponseSchema,
  type PatchExperimentRequestSchema,
  type StartRunRequestSchema,
  type StartRunResponseSchema,
} from "./resource-envelopes-experiment";
import type {
  ApiKeyParams,
  ApiKeyRevokeResponseSchema,
  AppParams,
  CanonicalEnvironmentSelectorQuerySchema,
  ClientKeyRotateResponseSchema,
  CreateApiKeyRequestSchema,
  CreateEnvironmentRequestSchema,
  EnvFlagParams,
  EnvParams,
  ExperimentParams,
  FlagConfigMutationResponseSchema,
  FlagConfigResponseSchema,
  PatchClientKeyRequestSchema,
  PatchEnvironmentRequestSchema,
  PatchFlagConfigRequestSchema,
  PromoteParams,
  PromoteRequestSchema,
  PromoteResponseSchema,
  ReplaceTargetingRulesRequestSchema,
} from "./routes/route-shapes";
import { listResponse } from "./wire-envelopes-core";

const EnvironmentListResponseSchema = listResponse(EnvironmentSchema);
const ExperimentListResponseSchema = listResponse(ExperimentResponseSchema);
export type EnvironmentSelectorInput = z.infer<typeof CanonicalEnvironmentSelectorQuerySchema>;
type InEnvironment<Input> = Input & EnvironmentSelectorInput;

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

export type FlagConfigGetInput = InEnvironment<z.infer<typeof EnvFlagParams>>;
export type FlagConfigGetOutput = z.infer<typeof FlagConfigResponseSchema>;
export type FlagConfigUpdateInput = InEnvironment<
  z.infer<typeof EnvFlagParams> & z.infer<typeof PatchFlagConfigRequestSchema>
>;
export type FlagConfigUpdateOutput = z.infer<typeof FlagConfigMutationResponseSchema>;
export type FlagTargetingRulesReplaceInput = InEnvironment<
  z.infer<typeof EnvFlagParams> & z.infer<typeof ReplaceTargetingRulesRequestSchema>
>;
export type FlagTargetingRulesReplaceOutput = z.infer<typeof FlagConfigMutationResponseSchema>;
export type FlagsPromoteInput = InEnvironment<
  z.infer<typeof PromoteParams> & z.infer<typeof PromoteRequestSchema>
>;
export type FlagsPromoteOutput = z.infer<typeof PromoteResponseSchema>;

export type ExperimentsListInput = InEnvironment<z.infer<typeof EnvParams>>;
export type ExperimentsListOutput = z.infer<typeof ExperimentListResponseSchema>;
export type ExperimentsCreateInput = InEnvironment<
  z.infer<typeof EnvParams> & z.infer<typeof CreateExperimentRequestSchema>
>;
export type ExperimentsCreateOutput = z.infer<typeof ExperimentResponseSchema>;
export type ExperimentsGetInput = InEnvironment<z.infer<typeof ExperimentParams>>;
export type ExperimentsGetOutput = z.infer<typeof ExperimentResponseSchema>;
export type ExperimentsUpdateInput = InEnvironment<
  z.infer<typeof ExperimentParams> & z.infer<typeof PatchExperimentRequestSchema>
>;
export type ExperimentsUpdateOutput = z.infer<typeof ExperimentUpdateResponseSchema>;
export type ExperimentsStartInput = InEnvironment<
  z.infer<typeof ExperimentParams> & z.infer<typeof StartRunRequestSchema>
>;
export type ExperimentsStartOutput = z.infer<typeof StartRunResponseSchema>;
export type ExperimentsDeleteInput = InEnvironment<z.infer<typeof ExperimentParams>>;
export type ExperimentsDeleteOutput = { deleted: true };

export type ClientKeyGetInput = InEnvironment<z.infer<typeof EnvParams>>;
export type ClientKeyGetOutput = z.infer<typeof ClientKeySchema>;
export type ClientKeyUpdateInput = InEnvironment<
  z.infer<typeof EnvParams> & z.infer<typeof PatchClientKeyRequestSchema>
>;
export type ClientKeyUpdateOutput = z.infer<typeof ClientKeySchema>;
export type ClientKeyRotateInput = InEnvironment<z.infer<typeof EnvParams>>;
export type ClientKeyRotateOutput = z.infer<typeof ClientKeyRotateResponseSchema>;
export type ApiKeysListInput = InEnvironment<z.infer<typeof EnvParams>>;
export type ApiKeysListOutput = z.infer<typeof ListCredentialsResponseSchema>;
export type ApiKeysCreateInput = InEnvironment<
  z.infer<typeof EnvParams> & z.infer<typeof CreateApiKeyRequestSchema>
>;
export type ApiKeysCreateOutput = z.infer<typeof CreateCredentialResponseSchema>;
export type ApiKeysRevokeInput = InEnvironment<z.infer<typeof ApiKeyParams>>;
export type ApiKeysRevokeOutput = z.infer<typeof ApiKeyRevokeResponseSchema>;
