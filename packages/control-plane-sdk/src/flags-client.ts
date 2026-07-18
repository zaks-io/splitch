import type {
  FlagConfigGetInput,
  FlagConfigGetOutput,
  FlagConfigUpdateInput,
  FlagConfigUpdateOutput,
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
  type ControlPlaneHcOptions,
  createFlagsHcClient,
  type FlagsHcClient,
  hcRequestOptions,
  withAuthorization,
} from "./hc-client";
import { invokeFlagsHcRoute } from "./hc-invoke";
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
  getConfig(
    input: FlagConfigGetInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagConfigGetOutput>>;
  updateConfig(
    input: FlagConfigUpdateInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<FlagConfigUpdateOutput>>;
}

export function createFlagsClient(
  hcOptions: ControlPlaneHcOptions,
  client?: FlagsHcClient,
): FlagsClient {
  const hcClient = client ?? createFlagsHcClient(hcOptions);

  return {
    list: (input, callOptions) =>
      invokeFlagsHcRoute<FlagsListOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "flags_list",
        (client, requestOptions) =>
          client.apps[":appId"].flags.$get(
            { param: { appId: input.appId } },
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      ),
    create: (input, callOptions) =>
      invokeFlagsHcRoute<FlagsCreateOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "flags_create",
        (client, requestOptions) =>
          client.apps[":appId"].flags.$post(
            { param: { appId: input.appId }, json: input } as never,
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      ),
    get: (input, callOptions) =>
      invokeFlagsHcRoute<FlagsGetOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "flags_get",
        (client, requestOptions) =>
          client.apps[":appId"].flags[":flagId"].$get(
            { param: { appId: input.appId, flagId: input.flagId } },
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      ),
    update: (input, callOptions) => {
      const { appId, flagId, ...body } = input;
      return invokeFlagsHcRoute<FlagsUpdateOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "flags_update",
        (client, requestOptions) =>
          client.apps[":appId"].flags[":flagId"].$patch(
            { param: { appId, flagId }, json: body } as never,
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      );
    },
    delete: (input, callOptions) =>
      invokeFlagsHcRoute<FlagsDeleteOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "flags_delete",
        (client, requestOptions) =>
          client.apps[":appId"].flags[":flagId"].$delete(
            { param: { appId: input.appId, flagId: input.flagId } },
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      ),
    getConfig: (input, callOptions) =>
      invokeFlagsHcRoute<FlagConfigGetOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "flag_config_get",
        (client, requestOptions) =>
          client.apps[":appId"].envs[":environmentId"].flags[":flagId"].config.$get(
            {
              param: {
                appId: input.appId,
                environmentId: input.environmentId,
                flagId: input.flagId,
              },
            },
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      ),
    updateConfig: (input, callOptions) => {
      const { appId, environmentId, flagId, ...body } = input;
      return invokeFlagsHcRoute<FlagConfigUpdateOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "flag_config_update",
        (client, requestOptions) =>
          client.apps[":appId"].envs[":environmentId"].flags[":flagId"].config.$patch(
            { param: { appId, environmentId, flagId }, json: body } as never,
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      );
    },
  };
}
