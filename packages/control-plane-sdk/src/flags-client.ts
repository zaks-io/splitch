import type {
  FlagsCreateInput,
  FlagsCreateOutput,
  FlagsDeleteInput,
  FlagsDeleteOutput,
  FlagsGetInput,
  FlagsGetOutput,
  FlagsListInput,
  FlagsListOutput,
  FlagsUpdateInput,
  FlagsUpdateOutput,
} from "@splitch/contracts/route-types";
import {
  createControlPlaneHcClient,
  hcRequestOptions,
  type ControlPlaneHcClient,
  type ControlPlaneHcOptions,
  withAuthorization,
} from "./hc-client";
import { invokeHcRoute } from "./hc-invoke";
import type { ControlPlaneOperationOptions, ControlPlaneOperationResult } from "./operation-result";

export interface FlagsClient {
  list(
    input: FlagsListInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagsListOutput>>;
  create(
    input: FlagsCreateInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagsCreateOutput>>;
  get(
    input: FlagsGetInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagsGetOutput>>;
  update(
    input: FlagsUpdateInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagsUpdateOutput>>;
  delete(
    input: FlagsDeleteInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagsDeleteOutput>>;
}

export function createFlagsClient(
  hcOptions: ControlPlaneHcOptions,
  client?: ControlPlaneHcClient,
): FlagsClient {
  const hcClient = client ?? createControlPlaneHcClient(hcOptions);

  return {
    list: (input, callOptions) =>
      invokeHcRoute<FlagsListOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "flags_list",
        (branch, requestOptions) =>
          branch.apps[":appId"].flags.$get(
            { param: { appId: input.appId } },
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      ),
    create: (input, callOptions) => {
      const { appId, ...body } = input;
      return invokeHcRoute<FlagsCreateOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "flags_create",
        (branch, requestOptions) =>
          branch.apps[":appId"].flags.$post(
            { param: { appId }, json: body },
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      );
    },
    get: (input, callOptions) =>
      invokeHcRoute<FlagsGetOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "flags_get",
        (branch, requestOptions) =>
          branch.apps[":appId"].flags[":flagId"].$get(
            { param: { appId: input.appId, flagId: input.flagId } },
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      ),
    update: (input, callOptions) => {
      const { appId, flagId, ...body } = input;
      return invokeHcRoute<FlagsUpdateOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "flags_update",
        (branch, requestOptions) =>
          branch.apps[":appId"].flags[":flagId"].$patch(
            { param: { appId, flagId }, json: body },
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      );
    },
    delete: (input, callOptions) =>
      invokeHcRoute<FlagsDeleteOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "flags_delete",
        (branch, requestOptions) =>
          branch.apps[":appId"].flags[":flagId"].$delete(
            { param: { appId: input.appId, flagId: input.flagId } },
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      ),
  };
}
