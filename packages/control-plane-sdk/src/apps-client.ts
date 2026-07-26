import type {
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
    delete: (input, callOptions) =>
      invokeHcRoute<AppsDeleteOutput>("apps_delete", () =>
        hcClient.apps[":appId"].$delete(
          { param: { appId: input.appId } },
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
  };
}
