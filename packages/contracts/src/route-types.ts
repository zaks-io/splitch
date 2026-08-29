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
import { AppMemberSchema, AppSchema } from "./leaf-schemas-runtime";
import type {
  ResourceDeleteModeQuerySchema,
  ResourceDeleteResponseSchema,
} from "./resource-delete-tree";
import type {
  AppAttentionRollupResponseSchema,
  CreateAppRequestSchema,
  CreateAppResponseSchema,
  CreateOrganizationRequestSchema,
  OrganizationResponseSchema,
  PatchAppRequestSchema,
} from "./resource-envelopes-account";
import type {
  CreateFlagRequestSchema,
  CreateVariantRequestSchema,
  FlagListReadResponseSchema,
  FlagMutationResponseSchema,
  FlagReadResponseSchema,
  FlagResponseSchema,
  PatchFlagRequestSchema,
  PatchVariantRequestSchema,
  PrincipalFlagListReadResponseSchema,
} from "./resource-envelopes-flag";
import type * as EnvironmentRoutes from "./route-types-environment";
import type {
  AddAppMemberRequestSchema,
  AppMemberParams,
  AppParams,
  ApprovalRequestParams,
  FlagGetQuerySchema,
  FlagListQuerySchema,
  FlagParams,
  FlagVariantParams,
  OrgAppsParams,
  PrincipalFlagListQuerySchema,
  UpdateAppMemberRequestSchema,
} from "./routes/route-shapes";

export type * from "./route-types-environment";

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
export type FlagsListOutput = z.infer<typeof FlagListReadResponseSchema>;
export type PrincipalFlagsListInput = z.infer<typeof PrincipalFlagListQuerySchema>;
export type PrincipalFlagsListOutput = z.infer<typeof PrincipalFlagListReadResponseSchema>;
export type FlagsCreateInput = z.infer<typeof AppParams> & z.infer<typeof CreateFlagRequestSchema>;
export type FlagsCreateOutput = z.infer<typeof FlagResponseSchema>;
export type FlagsGetInput = z.infer<typeof FlagParams> & z.infer<typeof FlagGetQuerySchema>;
export type FlagsGetOutput = z.infer<typeof FlagReadResponseSchema>;
export type FlagsUpdateInput = z.infer<typeof FlagParams> & z.infer<typeof PatchFlagRequestSchema>;
export type FlagsUpdateOutput = z.infer<typeof FlagResponseSchema>;
export type FlagsDeleteInput = z.infer<typeof FlagParams>;
export type FlagsDeleteOutput = z.infer<typeof DeletedResponseSchema>;
export type ApprovalRequestsListInput = z.infer<typeof AppParams> &
  z.infer<typeof ApprovalRequestListQuerySchema>;
export type ApprovalRequestsListOutput = z.infer<typeof ApprovalRequestListResponseSchema>;
export type ApprovalRequestsGetInput = z.infer<typeof ApprovalRequestParams>;
export type ApprovalRequestsGetOutput = z.infer<typeof ApprovalRequestSchema>;
export type ApprovalRequestReviewsCreateInput = z.infer<typeof ApprovalRequestParams> &
  z.infer<typeof ReviewApprovalRequestSchema>;
export type ApprovalRequestReviewsCreateOutput = z.infer<typeof ApprovalRequestSchema>;

export type FlagVariantsCreateInput = z.infer<typeof FlagParams> &
  z.infer<typeof CreateVariantRequestSchema>;
export type FlagVariantsCreateOutput = z.infer<typeof FlagResponseSchema>;
export type FlagVariantsUpdateInput = z.infer<typeof FlagVariantParams> &
  z.infer<typeof PatchVariantRequestSchema>;
export type FlagVariantsUpdateOutput = z.infer<typeof FlagMutationResponseSchema>;
export type FlagVariantsDeleteInput = z.infer<typeof FlagVariantParams>;
export type FlagVariantsDeleteOutput = z.infer<typeof FlagResponseSchema>;

const AppListResponseSchema = listResponse(AppSchema);
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

  environments_list: {
    input: EnvironmentRoutes.EnvironmentsListInput;
    output: EnvironmentRoutes.EnvironmentsListOutput;
  };
  environments_create: {
    input: EnvironmentRoutes.EnvironmentsCreateInput;
    output: EnvironmentRoutes.EnvironmentsCreateOutput;
  };
  environments_get: {
    input: EnvironmentRoutes.EnvironmentsGetInput;
    output: EnvironmentRoutes.EnvironmentsGetOutput;
  };
  environments_update: {
    input: EnvironmentRoutes.EnvironmentsUpdateInput;
    output: EnvironmentRoutes.EnvironmentsUpdateOutput;
  };
  environments_delete: {
    input: EnvironmentRoutes.EnvironmentsDeleteInput;
    output: EnvironmentRoutes.EnvironmentsDeleteOutput;
  };

  approval_requests_list: {
    input: ApprovalRequestsListInput;
    output: ApprovalRequestsListOutput;
  };
  approval_requests_get: { input: ApprovalRequestsGetInput; output: ApprovalRequestsGetOutput };
  approval_request_reviews_create: {
    input: ApprovalRequestReviewsCreateInput;
    output: ApprovalRequestReviewsCreateOutput;
  };

  client_key_get: {
    input: EnvironmentRoutes.ClientKeyGetInput;
    output: EnvironmentRoutes.ClientKeyGetOutput;
  };
  client_key_update: {
    input: EnvironmentRoutes.ClientKeyUpdateInput;
    output: EnvironmentRoutes.ClientKeyUpdateOutput;
  };
  client_key_rotate: {
    input: EnvironmentRoutes.ClientKeyRotateInput;
    output: EnvironmentRoutes.ClientKeyRotateOutput;
  };
  api_keys_list: {
    input: EnvironmentRoutes.ApiKeysListInput;
    output: EnvironmentRoutes.ApiKeysListOutput;
  };
  api_keys_create: {
    input: EnvironmentRoutes.ApiKeysCreateInput;
    output: EnvironmentRoutes.ApiKeysCreateOutput;
  };
  api_keys_revoke: {
    input: EnvironmentRoutes.ApiKeysRevokeInput;
    output: EnvironmentRoutes.ApiKeysRevokeOutput;
  };

  flags_list: { input: FlagsListInput; output: FlagsListOutput };
  principal_flags_list: { input: PrincipalFlagsListInput; output: PrincipalFlagsListOutput };
  flags_create: { input: FlagsCreateInput; output: FlagsCreateOutput };
  flags_get: { input: FlagsGetInput; output: FlagsGetOutput };
  flags_update: { input: FlagsUpdateInput; output: FlagsUpdateOutput };
  flags_delete: { input: FlagsDeleteInput; output: FlagsDeleteOutput };
  flag_variants_create: { input: FlagVariantsCreateInput; output: FlagVariantsCreateOutput };
  flag_variants_update: { input: FlagVariantsUpdateInput; output: FlagVariantsUpdateOutput };
  flag_variants_delete: { input: FlagVariantsDeleteInput; output: FlagVariantsDeleteOutput };
  flag_config_get: {
    input: EnvironmentRoutes.FlagConfigGetInput;
    output: EnvironmentRoutes.FlagConfigGetOutput;
  };
  flag_config_update: {
    input: EnvironmentRoutes.FlagConfigUpdateInput;
    output: EnvironmentRoutes.FlagConfigUpdateOutput;
  };
  flag_targeting_rules_replace: {
    input: EnvironmentRoutes.FlagTargetingRulesReplaceInput;
    output: EnvironmentRoutes.FlagTargetingRulesReplaceOutput;
  };
  flags_promote: {
    input: EnvironmentRoutes.FlagsPromoteInput;
    output: EnvironmentRoutes.FlagsPromoteOutput;
  };

  experiments_list: {
    input: EnvironmentRoutes.ExperimentsListInput;
    output: EnvironmentRoutes.ExperimentsListOutput;
  };
  experiments_create: {
    input: EnvironmentRoutes.ExperimentsCreateInput;
    output: EnvironmentRoutes.ExperimentsCreateOutput;
  };
  experiments_get: {
    input: EnvironmentRoutes.ExperimentsGetInput;
    output: EnvironmentRoutes.ExperimentsGetOutput;
  };
  experiments_update: {
    input: EnvironmentRoutes.ExperimentsUpdateInput;
    output: EnvironmentRoutes.ExperimentsUpdateOutput;
  };
  experiments_start: {
    input: EnvironmentRoutes.ExperimentsStartInput;
    output: EnvironmentRoutes.ExperimentsStartOutput;
  };
  experiments_delete: {
    input: EnvironmentRoutes.ExperimentsDeleteInput;
    output: EnvironmentRoutes.ExperimentsDeleteOutput;
  };
}

export type OperationId = keyof RouteTypeMap;

export type RouteFlatInput<Op extends OperationId> = RouteTypeMap[Op]["input"];

export type RouteOutput<Op extends OperationId> = RouteTypeMap[Op]["output"];

export type RouteInput<Op extends OperationId> = RouteFlatInput<Op>;
