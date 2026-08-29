import type {
  EnvironmentsCreateInput,
  EnvironmentsCreateOutput,
  EnvironmentsDeleteInput,
  EnvironmentsDeleteOutput,
  EnvironmentsGetInput,
  EnvironmentsGetOutput,
  EnvironmentsListInput,
  EnvironmentsListOutput,
  EnvironmentsUpdateInput,
  EnvironmentsUpdateOutput,
} from "@splitch/contracts/route-types";
import { environmentSelectorQuery } from "./environment-selector-query";
import {
  type ControlPlaneHcOptions,
  createEnvironmentsHcClient,
  type EnvironmentsHcClient,
  hcRequestOptions,
  withAuthorization,
} from "./hc-client";
import { invokeHcRoute } from "./hc-invoke";
import type { ControlPlaneOperationOptions, ControlPlaneOperationResult } from "./operation-result";

/**
 * Environment is a first-class axis under App (ADR-0027): every per-Environment
 * read/write the panel makes is scoped by `environmentId` from these operations.
 */
export interface EnvironmentsClient {
  list(
    input: EnvironmentsListInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<EnvironmentsListOutput>>;
  create(
    input: EnvironmentsCreateInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<EnvironmentsCreateOutput>>;
  get(
    input: EnvironmentsGetInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<EnvironmentsGetOutput>>;
  update(
    input: EnvironmentsUpdateInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<EnvironmentsUpdateOutput>>;
  delete(
    input: EnvironmentsDeleteInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<EnvironmentsDeleteOutput>>;
}

export function createEnvironmentsClient(
  hcOptions: ControlPlaneHcOptions,
  client?: EnvironmentsHcClient,
): EnvironmentsClient {
  const hcClient = client ?? createEnvironmentsHcClient(hcOptions);

  return {
    list: (input, callOptions) =>
      invokeHcRoute<EnvironmentsListOutput>("environments_list", () =>
        hcClient.apps[":appId"].envs.$get(
          { param: { appId: input.appId } },
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
    create: (input, callOptions) => {
      const { appId, ...body } = input;
      return invokeHcRoute<EnvironmentsCreateOutput>("environments_create", () =>
        hcClient.apps[":appId"].envs.$post(
          { param: { appId }, json: body } as never,
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      );
    },
    get: (input, callOptions) =>
      invokeHcRoute<EnvironmentsGetOutput>("environments_get", () =>
        hcClient.apps[":appId"].envs[":environmentId"].$get(
          {
            param: { appId: input.appId, environmentId: input.environmentId },
            ...environmentSelectorQuery(input),
          } as never,
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
    update: (input, callOptions) => {
      const { appId, environmentId, by, ...body } = input;
      return invokeHcRoute<EnvironmentsUpdateOutput>("environments_update", () =>
        hcClient.apps[":appId"].envs[":environmentId"].$patch(
          {
            param: { appId, environmentId },
            ...environmentSelectorQuery({ by }),
            json: body,
          } as never,
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      );
    },
    delete: (input, callOptions) =>
      invokeHcRoute<EnvironmentsDeleteOutput>("environments_delete", () =>
        hcClient.apps[":appId"].envs[":environmentId"].$delete(
          {
            param: { appId: input.appId, environmentId: input.environmentId },
            ...environmentSelectorQuery(input),
          } as never,
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
  };
}
