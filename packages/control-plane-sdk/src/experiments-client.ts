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
import { environmentSelectorQuery } from "./environment-selector-query";
import {
  type ControlPlaneHcOptions,
  createExperimentsHcClient,
  type ExperimentsHcClient,
  hcRequestOptions,
  withAuthorization,
} from "./hc-client";
import { invokeHcRoute } from "./hc-invoke";
import { withIdempotencyHeader } from "./idempotency-header";
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
      invokeHcRoute<ExperimentsListOutput>("experiments_list", () =>
        hcClient.apps[":appId"].envs[":environmentId"].experiments.$get(
          {
            param: { appId: input.appId, environmentId: input.environmentId },
            ...environmentSelectorQuery(input),
          } as never,
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
    create: (input, callOptions) => {
      const { by, ...body } = input;
      return invokeHcRoute<ExperimentsCreateOutput>("experiments_create", () =>
        hcClient.apps[":appId"].envs[":environmentId"].experiments.$post(
          {
            param: { appId: input.appId, environmentId: input.environmentId },
            ...environmentSelectorQuery({ by }),
            json: body,
          } as never,
          withIdempotencyHeader(
            "experiments_create",
            hcRequestOptions(withAuthorization(hcOptions, callOptions)),
            input.idempotency_key,
          ),
        ),
      );
    },
    get: (input, callOptions) =>
      invokeHcRoute<ExperimentsGetOutput>("experiments_get", () =>
        hcClient.apps[":appId"].envs[":environmentId"].experiments[":experimentId"].$get(
          {
            param: {
              appId: input.appId,
              environmentId: input.environmentId,
              experimentId: input.experimentId,
            },
            ...environmentSelectorQuery(input),
          } as never,
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
    update: (input, callOptions) => {
      const { appId, environmentId, experimentId, by, ...body } = input;
      return invokeHcRoute<ExperimentsUpdateOutput>("experiments_update", () =>
        hcClient.apps[":appId"].envs[":environmentId"].experiments[":experimentId"].$patch(
          {
            param: { appId, environmentId, experimentId },
            ...environmentSelectorQuery({ by }),
            json: body,
          } as never,
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      );
    },
    start: (input, callOptions) => {
      const { appId, environmentId, experimentId, by, ...body } = input;
      return invokeHcRoute<ExperimentsStartOutput>("experiments_start", () =>
        hcClient.apps[":appId"].envs[":environmentId"].experiments[":experimentId"].start.$post(
          {
            param: { appId, environmentId, experimentId },
            ...environmentSelectorQuery({ by }),
            json: body,
          } as never,
          withIdempotencyHeader(
            "experiments_start",
            hcRequestOptions(withAuthorization(hcOptions, callOptions)),
            body.idempotency_key,
          ),
        ),
      );
    },
    delete: (input, callOptions) =>
      invokeHcRoute<ExperimentsDeleteOutput>("experiments_delete", () =>
        hcClient.apps[":appId"].envs[":environmentId"].experiments[":experimentId"].$delete(
          {
            param: {
              appId: input.appId,
              environmentId: input.environmentId,
              experimentId: input.experimentId,
            },
            ...environmentSelectorQuery(input),
          } as never,
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
  };
}
