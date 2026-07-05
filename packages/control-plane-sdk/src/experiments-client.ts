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
  createControlPlaneHcClient,
  hcRequestOptions,
  type ControlPlaneHcClient,
  type ControlPlaneHcOptions,
  withAuthorization,
} from "./hc-client";
import { invokeHcRoute } from "./hc-invoke";
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
  client?: ControlPlaneHcClient,
): ExperimentsClient {
  const hcClient = client ?? createControlPlaneHcClient(hcOptions);

  return {
    list: (input, callOptions) =>
      invokeHcRoute<ExperimentsListOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "experiments_list",
        (branch, requestOptions) =>
          branch.apps[":appId"].envs[":environmentId"].experiments.$get(
            { param: { appId: input.appId, environmentId: input.environmentId } },
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      ),
    create: (input, callOptions) => {
      const { appId, environmentId, ...body } = input;
      return invokeHcRoute<ExperimentsCreateOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "experiments_create",
        (branch, requestOptions) =>
          branch.apps[":appId"].envs[":environmentId"].experiments.$post(
            { param: { appId, environmentId }, json: body },
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      );
    },
    get: (input, callOptions) =>
      invokeHcRoute<ExperimentsGetOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "experiments_get",
        (branch, requestOptions) =>
          branch.apps[":appId"].envs[":environmentId"].experiments[":experimentId"].$get(
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
      return invokeHcRoute<ExperimentsUpdateOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "experiments_update",
        (branch, requestOptions) =>
          branch.apps[":appId"].envs[":environmentId"].experiments[":experimentId"].$patch(
            { param: { appId, environmentId, experimentId }, json: body },
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      );
    },
    start: (input, callOptions) => {
      const { appId, environmentId, experimentId, ...body } = input;
      return invokeHcRoute<ExperimentsStartOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "experiments_start",
        (branch, requestOptions) =>
          branch.apps[":appId"].envs[":environmentId"].experiments[":experimentId"].start.$post(
            { param: { appId, environmentId, experimentId }, json: body },
            { ...requestOptions, ...hcRequestOptions(withAuthorization(hcOptions, callOptions)) },
          ),
      );
    },
    delete: (input, callOptions) =>
      invokeHcRoute<ExperimentsDeleteOutput>(
        hcClient,
        withAuthorization(hcOptions, callOptions),
        "experiments_delete",
        (branch, requestOptions) =>
          branch.apps[":appId"].envs[":environmentId"].experiments[":experimentId"].$delete(
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
