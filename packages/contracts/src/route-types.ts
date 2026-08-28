import { z } from "@hono/zod-openapi";
import type {
  EventDefinitionDetailSchema,
  EventDefinitionListResponseSchema,
  EventDefinitionSchema,
  EventDefinitionVersionListResponseSchema,
  EventDefinitionVersionSchema,
} from "./event-definition";
import type {
  CreateEventDefinitionRequestSchema,
  PatchEventDefinitionRequestSchema,
  PublishEventDefinitionVersionRequestSchema,
} from "./event-definition-write";
import {
  AppMemberSchema,
  AppSchema,
  type ClientKeySchema,
  EnvironmentSchema,
} from "./leaf-schemas-runtime";
import type {
  ResourceDeleteModeQuerySchema,
  ResourceDeleteResponseSchema,
} from "./resource-delete-tree";
import type {
  AppAttentionRollupResponseSchema,
  CreateAppRequestSchema,
  CreateAppResponseSchema,
  CreateCredentialResponseSchema,
  CreateEnvironmentResponseSchema,
  CreateOrganizationRequestSchema,
  ListCredentialsResponseSchema,
  OrganizationResponseSchema,
  PatchAppRequestSchema,
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
  CreateFlagRequestSchema,
  CreateVariantRequestSchema,
  FlagListResponseSchema,
  FlagMutationResponseSchema,
  FlagResponseSchema,
  PatchFlagRequestSchema,
  PatchVariantRequestSchema,
} from "./resource-envelopes-flag";
import type {
  AddAppMemberRequestSchema,
  ApiKeyParams,
  ApiKeyRevokeResponseSchema,
  AppMemberParams,
  AppParams,
  ApprovalRequestParams,
  ClientKeyRotateResponseSchema,
  CreateApiKeyRequestSchema,
  CreateEnvironmentRequestSchema,
  EnvFlagParams,
  EnvParams,
  ExperimentParams,
  FlagConfigMutationResponseSchema,
  FlagConfigResponseSchema,
  FlagGetQuerySchema,
  FlagListQuerySchema,
  FlagParams,
  FlagVariantParams,
  OrgAppsParams,
  PatchClientKeyRequestSchema,
  PatchEnvironmentRequestSchema,
  PatchFlagConfigRequestSchema,
  PromoteParams,
  PromoteRequestSchema,
  PromoteResponseSchema,
  ReplaceTargetingRulesRequestSchema,
  UpdateAppMemberRequestSchema,
} from "./routes/route-shapes";
import {
  type ApprovalRequestListQuerySchema,
  ApprovalRequestSchema,
  type ReviewApprovalRequestSchema,
} from "./routes/route-shapes-approval-request";
import { listResponse } from "./wire-envelopes-core";

/**
 * Typed flat inputs/outputs for representative Control Plane operations.
 * These compose the same Zod schemas the route registry uses — no parallel request
 * shapes in the SDK.
 */

const ExperimentListResponseSchema = listResponse(ExperimentResponseSchema);
const ApprovalRequestListResponseSchema = listResponse(ApprovalRequestSchema);
const DeletedResponseSchema = z.object({ deleted: z.literal(true) });

type EventDefinitionPath = z.infer<typeof AppParams> & { eventDefinitionId: string };
type EventDefinitionVersionPath = EventDefinitionPath & { versionId: string };
export type EventDefinitionsListInput = z.infer<typeof AppParams>;
export type EventDefinitionsListOutput = z.infer<typeof EventDefinitionListResponseSchema>;
export type EventDefinitionsCreateInput = z.infer<typeof AppParams> &
  z.infer<typeof CreateEventDefinitionRequestSchema>;
export type EventDefinitionsCreateOutput = z.infer<typeof EventDefinitionSchema>;
export type EventDefinitionsGetInput = EventDefinitionPath;
export type EventDefinitionsGetOutput = z.infer<typeof EventDefinitionDetailSchema>;
export type EventDefinitionsUpdateInput = EventDefinitionPath &
  z.infer<typeof PatchEventDefinitionRequestSchema>;
export type EventDefinitionsUpdateOutput = z.infer<typeof EventDefinitionSchema>;
export type EventDefinitionVersionsCreateInput = EventDefinitionPath &
  z.infer<typeof PublishEventDefinitionVersionRequestSchema>;
export type EventDefinitionVersionsCreateOutput = z.infer<typeof EventDefinitionVersionSchema>;
export type EventDefinitionVersionsListInput = EventDefinitionPath;
export type EventDefinitionVersionsListOutput = z.infer<
  typeof EventDefinitionVersionListResponseSchema
>;
export type EventDefinitionVersionsGetInput = EventDefinitionVersionPath;
export type EventDefinitionVersionsGetOutput = z.infer<typeof EventDefinitionVersionSchema>;

export type FlagsListInput = z.infer<typeof AppParams> & z.infer<typeof FlagListQuerySchema>;
export type FlagsListOutput = z.infer<typeof FlagListResponseSchema>;
export type FlagsCreateInput = z.infer<typeof AppParams> & z.infer<typeof CreateFlagRequestSchema>;
export type FlagsCreateOutput = z.infer<typeof FlagResponseSchema>;
export type FlagsGetInput = z.infer<typeof FlagParams> & z.infer<typeof FlagGetQuerySchema>;
export type FlagsGetOutput = z.infer<typeof FlagResponseSchema>;
export type FlagsUpdateInput = z.infer<typeof FlagParams> & z.infer<typeof PatchFlagRequestSchema>;
export type FlagsUpdateOutput = z.infer<typeof FlagResponseSchema>;
export type FlagsDeleteInput = z.infer<typeof FlagParams>;
export type FlagsDeleteOutput = z.infer<typeof DeletedResponseSchema>;
export type FlagConfigGetInput = z.infer<typeof EnvFlagParams>;
export type FlagConfigGetOutput = z.infer<typeof FlagConfigResponseSchema>;
export type FlagConfigUpdateInput = z.infer<typeof EnvFlagParams> &
  z.infer<typeof PatchFlagConfigRequestSchema>;
export type FlagConfigUpdateOutput = z.infer<typeof FlagConfigMutationResponseSchema>;

export type ApprovalRequestsListInput = z.infer<typeof AppParams> &
  z.infer<typeof ApprovalRequestListQuerySchema>;
export type ApprovalRequestsListOutput = z.infer<typeof ApprovalRequestListResponseSchema>;
export type ApprovalRequestsGetInput = z.infer<typeof ApprovalRequestParams>;
export type ApprovalRequestsGetOutput = z.infer<typeof ApprovalRequestSchema>;
export type ApprovalRequestReviewsCreateInput = z.infer<typeof ApprovalRequestParams> &
  z.infer<typeof ReviewApprovalRequestSchema>;
export type ApprovalRequestReviewsCreateOutput = z.infer<typeof ApprovalRequestSchema>;

export type ExperimentsListInput = z.infer<typeof EnvParams>;
export type ExperimentsListOutput = z.infer<typeof ExperimentListResponseSchema>;
export type ExperimentsCreateInput = z.infer<typeof EnvParams> &
  z.infer<typeof CreateExperimentRequestSchema>;
export type ExperimentsCreateOutput = z.infer<typeof ExperimentResponseSchema>;
export type ExperimentsGetInput = z.infer<typeof ExperimentParams>;
export type ExperimentsGetOutput = z.infer<typeof ExperimentResponseSchema>;
export type ExperimentsUpdateInput = z.infer<typeof ExperimentParams> &
  z.infer<typeof PatchExperimentRequestSchema>;
export type ExperimentsUpdateOutput = z.infer<typeof ExperimentUpdateResponseSchema>;
export type ExperimentsStartInput = z.infer<typeof ExperimentParams> &
  z.infer<typeof StartRunRequestSchema>;
export type ExperimentsStartOutput = z.infer<typeof StartRunResponseSchema>;
export type ExperimentsDeleteInput = z.infer<typeof ExperimentParams>;
export type ExperimentsDeleteOutput = z.infer<typeof DeletedResponseSchema>;

export type FlagVariantsCreateInput = z.infer<typeof FlagParams> &
  z.infer<typeof CreateVariantRequestSchema>;
export type FlagVariantsCreateOutput = z.infer<typeof FlagResponseSchema>;
export type FlagVariantsUpdateInput = z.infer<typeof FlagVariantParams> &
  z.infer<typeof PatchVariantRequestSchema>;
export type FlagVariantsUpdateOutput = z.infer<typeof FlagMutationResponseSchema>;
export type FlagVariantsDeleteInput = z.infer<typeof FlagVariantParams>;
export type FlagVariantsDeleteOutput = z.infer<typeof FlagResponseSchema>;

export type FlagTargetingRulesReplaceInput = z.infer<typeof EnvFlagParams> &
  z.infer<typeof ReplaceTargetingRulesRequestSchema>;
export type FlagTargetingRulesReplaceOutput = z.infer<typeof FlagConfigMutationResponseSchema>;

export type FlagsPromoteInput = z.infer<typeof PromoteParams> &
  z.infer<typeof PromoteRequestSchema>;
export type FlagsPromoteOutput = z.infer<typeof PromoteResponseSchema>;

const AppListResponseSchema = listResponse(AppSchema);
const EnvironmentListResponseSchema = listResponse(EnvironmentSchema);
const AppMemberListResponseSchema = listResponse(AppMemberSchema);

// No path params: the Org does not exist yet, so the body is the whole input.
export type OrganizationsCreateInput = z.infer<typeof CreateOrganizationRequestSchema>;
export type OrganizationsCreateOutput = z.infer<typeof OrganizationResponseSchema>;

export type AppsCreateInput = z.infer<typeof OrgAppsParams> &
  z.infer<typeof CreateAppRequestSchema>;
export type AppsCreateOutput = z.infer<typeof CreateAppResponseSchema>;
export type AppsListInput = z.infer<typeof OrgAppsParams>;
export type AppsListOutput = z.infer<typeof AppListResponseSchema>;
export type AppsGetInput = z.infer<typeof AppParams>;
export type AppsGetOutput = z.infer<typeof AppSchema>;
export type AppsUpdateInput = z.infer<typeof AppParams> & z.infer<typeof PatchAppRequestSchema>;
export type AppsUpdateOutput = z.infer<typeof AppSchema>;
export type AppsDeleteInput = z.infer<typeof AppParams> &
  z.infer<typeof ResourceDeleteModeQuerySchema>;
export type AppsDeleteOutput = z.infer<typeof ResourceDeleteResponseSchema>;
export type AppMembersListInput = z.infer<typeof AppParams>;
export type AppMembersListOutput = z.infer<typeof AppMemberListResponseSchema>;
export type AppMembersAddInput = z.infer<typeof AppParams> &
  z.infer<typeof AddAppMemberRequestSchema>;
export type AppMembersAddOutput = z.infer<typeof AppMemberSchema>;
export type AppMembersUpdateInput = z.infer<typeof AppMemberParams> &
  z.infer<typeof UpdateAppMemberRequestSchema>;
export type AppMembersUpdateOutput = z.infer<typeof AppMemberSchema>;
export type AppMembersRemoveInput = z.infer<typeof AppMemberParams>;
export type AppMembersRemoveOutput = { deleted: true };

export type AppAttentionRollupGetInput = z.infer<typeof AppParams>;
export type AppAttentionRollupGetOutput = z.infer<typeof AppAttentionRollupResponseSchema>;

export type EnvironmentsListInput = z.infer<typeof AppParams>;
export type EnvironmentsListOutput = z.infer<typeof EnvironmentListResponseSchema>;
export type EnvironmentsCreateInput = z.infer<typeof AppParams> &
  z.infer<typeof CreateEnvironmentRequestSchema>;
export type EnvironmentsCreateOutput = z.infer<typeof CreateEnvironmentResponseSchema>;
export type EnvironmentsGetInput = z.infer<typeof EnvParams>;
export type EnvironmentsGetOutput = z.infer<typeof EnvironmentSchema>;
export type EnvironmentsUpdateInput = z.infer<typeof EnvParams> &
  z.infer<typeof PatchEnvironmentRequestSchema>;
export type EnvironmentsUpdateOutput = z.infer<typeof EnvironmentSchema>;
export type EnvironmentsDeleteInput = z.infer<typeof EnvParams>;
export type EnvironmentsDeleteOutput = z.infer<typeof DeletedResponseSchema>;

export type ClientKeyGetInput = z.infer<typeof EnvParams>;
export type ClientKeyGetOutput = z.infer<typeof ClientKeySchema>;
export type ClientKeyUpdateInput = z.infer<typeof EnvParams> &
  z.infer<typeof PatchClientKeyRequestSchema>;
export type ClientKeyUpdateOutput = z.infer<typeof ClientKeySchema>;
export type ClientKeyRotateInput = z.infer<typeof EnvParams>;
export type ClientKeyRotateOutput = z.infer<typeof ClientKeyRotateResponseSchema>;

export type ApiKeysListInput = z.infer<typeof EnvParams>;
export type ApiKeysListOutput = z.infer<typeof ListCredentialsResponseSchema>;
/**
 * The minted API Key's raw secret rides `value` on THIS response only — it is
 * surfaced once and is never re-readable. `ApiKeysListOutput` composes the
 * APIKey leaf, which carries no key-material field at all (ADR-0018/ADR-0022),
 * so there is no type-level path from a list read back to a secret.
 */
export type ApiKeysCreateInput = z.infer<typeof EnvParams> &
  z.infer<typeof CreateApiKeyRequestSchema>;
export type ApiKeysCreateOutput = z.infer<typeof CreateCredentialResponseSchema>;
export type ApiKeysRevokeInput = z.infer<typeof ApiKeyParams>;
export type ApiKeysRevokeOutput = z.infer<typeof ApiKeyRevokeResponseSchema>;

/**
 * operationId -> flat input/output map. Single source of truth: `OperationId`,
 * `RouteFlatInput`, and `RouteOutput` all derive from it, so adding an operation
 * is one entry rather than three parallel edits.
 */
export interface RouteTypeMap {
  event_definitions_list: { input: EventDefinitionsListInput; output: EventDefinitionsListOutput };
  event_definitions_create: {
    input: EventDefinitionsCreateInput;
    output: EventDefinitionsCreateOutput;
  };
  event_definitions_get: { input: EventDefinitionsGetInput; output: EventDefinitionsGetOutput };
  event_definitions_update: {
    input: EventDefinitionsUpdateInput;
    output: EventDefinitionsUpdateOutput;
  };
  event_definition_versions_create: {
    input: EventDefinitionVersionsCreateInput;
    output: EventDefinitionVersionsCreateOutput;
  };
  event_definition_versions_list: {
    input: EventDefinitionVersionsListInput;
    output: EventDefinitionVersionsListOutput;
  };
  event_definition_versions_get: {
    input: EventDefinitionVersionsGetInput;
    output: EventDefinitionVersionsGetOutput;
  };
  organizations_create: { input: OrganizationsCreateInput; output: OrganizationsCreateOutput };

  apps_list: { input: AppsListInput; output: AppsListOutput };
  apps_create: { input: AppsCreateInput; output: AppsCreateOutput };
  apps_get: { input: AppsGetInput; output: AppsGetOutput };
  apps_update: { input: AppsUpdateInput; output: AppsUpdateOutput };
  apps_delete: { input: AppsDeleteInput; output: AppsDeleteOutput };
  app_members_list: { input: AppMembersListInput; output: AppMembersListOutput };
  app_members_add: { input: AppMembersAddInput; output: AppMembersAddOutput };
  app_members_update: { input: AppMembersUpdateInput; output: AppMembersUpdateOutput };
  app_members_remove: { input: AppMembersRemoveInput; output: AppMembersRemoveOutput };
  app_attention_rollup_get: {
    input: AppAttentionRollupGetInput;
    output: AppAttentionRollupGetOutput;
  };

  environments_list: { input: EnvironmentsListInput; output: EnvironmentsListOutput };
  environments_create: { input: EnvironmentsCreateInput; output: EnvironmentsCreateOutput };
  environments_get: { input: EnvironmentsGetInput; output: EnvironmentsGetOutput };
  environments_update: { input: EnvironmentsUpdateInput; output: EnvironmentsUpdateOutput };
  environments_delete: { input: EnvironmentsDeleteInput; output: EnvironmentsDeleteOutput };

  approval_requests_list: {
    input: ApprovalRequestsListInput;
    output: ApprovalRequestsListOutput;
  };
  approval_requests_get: { input: ApprovalRequestsGetInput; output: ApprovalRequestsGetOutput };
  approval_request_reviews_create: {
    input: ApprovalRequestReviewsCreateInput;
    output: ApprovalRequestReviewsCreateOutput;
  };

  client_key_get: { input: ClientKeyGetInput; output: ClientKeyGetOutput };
  client_key_update: { input: ClientKeyUpdateInput; output: ClientKeyUpdateOutput };
  client_key_rotate: { input: ClientKeyRotateInput; output: ClientKeyRotateOutput };
  api_keys_list: { input: ApiKeysListInput; output: ApiKeysListOutput };
  api_keys_create: { input: ApiKeysCreateInput; output: ApiKeysCreateOutput };
  api_keys_revoke: { input: ApiKeysRevokeInput; output: ApiKeysRevokeOutput };

  flags_list: { input: FlagsListInput; output: FlagsListOutput };
  flags_create: { input: FlagsCreateInput; output: FlagsCreateOutput };
  flags_get: { input: FlagsGetInput; output: FlagsGetOutput };
  flags_update: { input: FlagsUpdateInput; output: FlagsUpdateOutput };
  flags_delete: { input: FlagsDeleteInput; output: FlagsDeleteOutput };
  flag_variants_create: { input: FlagVariantsCreateInput; output: FlagVariantsCreateOutput };
  flag_variants_update: { input: FlagVariantsUpdateInput; output: FlagVariantsUpdateOutput };
  flag_variants_delete: { input: FlagVariantsDeleteInput; output: FlagVariantsDeleteOutput };
  flag_config_get: { input: FlagConfigGetInput; output: FlagConfigGetOutput };
  flag_config_update: { input: FlagConfigUpdateInput; output: FlagConfigUpdateOutput };
  flag_targeting_rules_replace: {
    input: FlagTargetingRulesReplaceInput;
    output: FlagTargetingRulesReplaceOutput;
  };
  flags_promote: { input: FlagsPromoteInput; output: FlagsPromoteOutput };

  experiments_list: { input: ExperimentsListInput; output: ExperimentsListOutput };
  experiments_create: { input: ExperimentsCreateInput; output: ExperimentsCreateOutput };
  experiments_get: { input: ExperimentsGetInput; output: ExperimentsGetOutput };
  experiments_update: { input: ExperimentsUpdateInput; output: ExperimentsUpdateOutput };
  experiments_start: { input: ExperimentsStartInput; output: ExperimentsStartOutput };
  experiments_delete: { input: ExperimentsDeleteInput; output: ExperimentsDeleteOutput };
}

export type OperationId = keyof RouteTypeMap;

export type RouteFlatInput<Op extends OperationId> = RouteTypeMap[Op]["input"];

export type RouteOutput<Op extends OperationId> = RouteTypeMap[Op]["output"];

export type RouteInput<Op extends OperationId> = RouteFlatInput<Op>;
