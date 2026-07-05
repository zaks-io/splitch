import type {
  ExperimentsCreateInput,
  ExperimentsCreateOutput,
  ExperimentsDeleteInput,
  ExperimentsDeleteOutput,
  ExperimentsGetInput,
  ExperimentsGetOutput,
  ExperimentsListInput,
  ExperimentsListOutput,
  ExperimentsStartInput,
  ExperimentsStartOutput,
  ExperimentsUpdateInput,
  ExperimentsUpdateOutput,
} from "@splitch/contracts/route-types";
import {
  createExperimentsHcClient,
  hcRequestOptions,
  type ExperimentsHcClient,
  type ControlPlaneHcOptions,
  withAuthorization,
} from "./hc-client";
import { invokeExperimentsHcRoute } from "./hc-invoke";
import type { ControlPlaneOperationOptions, ControlPlaneOperationResult } from "./operation-result";

export interface ExperimentsClient {
  list(
    input: ExperimentsListInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<ExperimentsListOutput>>;
  create(
    input: ExperimentsCreateInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<ExperimentsCreateOutput>>;
  get(
    input: ExperimentsGetInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<ExperimentsGetOutput>>;
  update(
    input: ExperimentsUpdateInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<ExperimentsUpdateOutput>>;
  start(
    input: ExperimentsStartInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<ExperimentsStartOutput>>;
  delete(
    input: ExperimentsDeleteInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<ExperimentsDeleteOutput>>;
}

export function createExperimentsClient(
  hcOptions: ControlPlaneHcOptions,
  client?: ExperimentsHcClient,
): ExperimentsClient {
  const hcClient = client ?? createExperimentsHcClient(hcOptions);

  return {
    list: (input, callOptions) =>
      invokeExperimentsHcRoute<ExperimentsListOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "experiments_list",
        (client, requestOptions) =>
          client.apps[":appId"].envs[":environmentId"].experiments.$get(
            { param: { appId: input.appId, environmentId: input.environmentId } },
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      ),
    create: (input, callOptions) =>
      invokeExperimentsHcRoute<ExperimentsCreateOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "experiments_create",
        (client, requestOptions) =>
          client.apps[":appId"].envs[":environmentId"].experiments.$post(
            {
              param: { appId: input.appId, environmentId: input.environmentId },
              json: input,
            } as never,
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      ),
    get: (input, callOptions) =>
      invokeExperimentsHcRoute<ExperimentsGetOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "experiments_get",
        (client, requestOptions) =>
          client.apps[":appId"].envs[":environmentId"].experiments[":experimentId"].$get(
            {
              param: {
                appId: input.appId,
                environmentId: input.environmentId,
                experimentId: input.experimentId,
              },
            },
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      ),
    update: (input, callOptions) => {
      const { appId, environmentId, experimentId, ...body } = input;
      return invokeExperimentsHcRoute<ExperimentsUpdateOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "experiments_update",
        (client, requestOptions) =>
          client.apps[":appId"].envs[":environmentId"].experiments[":experimentId"].$patch(
            { param: { appId, environmentId, experimentId }, json: body } as never,
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      );
    },
    start: (input, callOptions) => {
      const { appId, environmentId, experimentId, ...body } = input;
      return invokeExperimentsHcRoute<ExperimentsStartOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "experiments_start",
        (client, requestOptions) =>
          client.apps[":appId"].envs[":environmentId"].experiments[":experimentId"].start.$post(
            { param: { appId, environmentId, experimentId }, json: body } as never,
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      );
    },
    delete: (input, callOptions) =>
      invokeExperimentsHcRoute<ExperimentsDeleteOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "experiments_delete",
        (client, requestOptions) =>
          client.apps[":appId"].envs[":environmentId"].experiments[":experimentId"].$delete(
            {
              param: {
                appId: input.appId,
                environmentId: input.environmentId,
                experimentId: input.experimentId,
              },
            },
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      ),
  };
}
