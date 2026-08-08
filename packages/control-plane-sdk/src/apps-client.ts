import type {
  AppAttentionRollupGetInput,
  AppAttentionRollupGetOutput,
  AppMembersAddInput,
  AppMembersAddOutput,
  AppMembersListInput,
  AppMembersListOutput,
  AppMembersRemoveInput,
  AppMembersRemoveOutput,
  AppMembersUpdateInput,
  AppMembersUpdateOutput,
  AppsCreateInput,
  AppsCreateOutput,
  AppsDeleteInput,
  AppsDeleteOutput,
  AppsGetInput,
  AppsGetOutput,
  AppsListInput,
  AppsListOutput,
  AppsUpdateInput,
  AppsUpdateOutput,
} from "@splitch/contracts/route-types";
import {
  type AppsHcClient,
  type ControlPlaneHcOptions,
  createAppsHcClient,
  hcRequestOptions,
  withAuthorization,
} from "./hc-client";
import { invokeHcRoute } from "./hc-invoke";
import type { ControlPlaneOperationOptions, ControlPlaneOperationResult } from "./operation-result";

export interface AppsClient {
  list(
    input: AppsListInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<AppsListOutput>>;
  create(
    input: AppsCreateInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<AppsCreateOutput>>;
  get(
    input: AppsGetInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<AppsGetOutput>>;
  update(
    input: AppsUpdateInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<AppsUpdateOutput>>;
  delete(
    input: AppsDeleteInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<AppsDeleteOutput>>;
  getAttentionRollup(
    input: AppAttentionRollupGetInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<AppAttentionRollupGetOutput>>;
  /**
   * The App's own access list, distinct from Organization membership: being in
   * the Org does not grant access to an App.
   */
  readonly members: AppMembersClient;
}

interface AppMembersClient {
  list(
    input: AppMembersListInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<AppMembersListOutput>>;
  add(
    input: AppMembersAddInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<AppMembersAddOutput>>;
  update(
    input: AppMembersUpdateInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<AppMembersUpdateOutput>>;
  remove(
    input: AppMembersRemoveInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<AppMembersRemoveOutput>>;
}

export function createAppsClient(
  hcOptions: ControlPlaneHcOptions,
  client?: AppsHcClient,
): AppsClient {
  const hcClient = client ?? createAppsHcClient(hcOptions);
  return {
    list: (input, callOptions) =>
      invokeHcRoute<AppsListOutput>("apps_list", () =>
        hcClient.orgs[":orgId"].apps.$get(
          { param: { orgId: input.orgId } },
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
    create: (input, callOptions) => {
      const { orgId, ...body } = input;
      return invokeHcRoute<AppsCreateOutput>("apps_create", () =>
        hcClient.orgs[":orgId"].apps.$post(
          { param: { orgId }, json: body } as never,
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      );
    },
    get: (input, callOptions) =>
      invokeHcRoute<AppsGetOutput>("apps_get", () =>
        hcClient.apps[":appId"].$get(
          { param: { appId: input.appId } },
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
    update: (input, callOptions) => {
      const { appId, ...body } = input;
      return invokeHcRoute<AppsUpdateOutput>("apps_update", () =>
        hcClient.apps[":appId"].$patch(
          { param: { appId }, json: body } as never,
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      );
    },
    delete: (input, callOptions) => {
      const { appId, dryRun, force } = input;
      return invokeHcRoute<AppsDeleteOutput>("apps_delete", () =>
        hcClient.apps[":appId"].$delete(
          {
            param: { appId },
            query: {
              ...(dryRun === true ? { dryRun: "true" } : {}),
              ...(force === true ? { force: "true" } : {}),
            },
          } as never,
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      );
    },
    getAttentionRollup: (input, callOptions) =>
      invokeHcRoute<AppAttentionRollupGetOutput>("app_attention_rollup_get", () =>
        hcClient.apps[":appId"]["attention-rollup"].$get(
          { param: { appId: input.appId } },
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
    members: createAppMembersClient(hcOptions, hcClient),
  };
}

function createAppMembersClient(
  hcOptions: ControlPlaneHcOptions,
  hcClient: AppsHcClient,
): AppMembersClient {
  return {
    list: (input, callOptions) =>
      invokeHcRoute<AppMembersListOutput>("app_members_list", () =>
        hcClient.apps[":appId"].members.$get(
          { param: { appId: input.appId } },
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
    add: (input, callOptions) => {
      const { appId, ...body } = input;
      return invokeHcRoute<AppMembersAddOutput>("app_members_add", () =>
        hcClient.apps[":appId"].members.$post(
          { param: { appId }, json: body } as never,
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      );
    },
    update: (input, callOptions) => {
      const { appId, userId, ...body } = input;
      return invokeHcRoute<AppMembersUpdateOutput>("app_members_update", () =>
        hcClient.apps[":appId"].members[":userId"].$patch(
          { param: { appId, userId }, json: body } as never,
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      );
    },
    remove: (input, callOptions) =>
      invokeHcRoute<AppMembersRemoveOutput>("app_members_remove", () =>
        hcClient.apps[":appId"].members[":userId"].$delete(
          { param: { appId: input.appId, userId: input.userId } },
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
  };
}
