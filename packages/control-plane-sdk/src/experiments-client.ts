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
  type ControlPlaneHcOptions,
  createExperimentsHcClient,
  type ExperimentsHcClient,
  hcRequestOptions,
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

/**
 * `experiments_start` declares `idempotency: "required"` and the runtime guard
 * reads the HEADER, while the typed request carries `idempotency_key` in the
 * BODY. Without mirroring one onto the other, every typed caller of Start is
 * refused with a VALIDATION_ERROR before the handler ever runs. The MCP adapter
 * already applies this same body → header rule; this keeps the typed client and
 * the adapter answering the transport the same way rather than making each
 * caller remember a header the contract already describes.
 */
function withIdempotencyHeader(
  options: { headers?: Record<string, string> },
  body: unknown,
): { headers?: Record<string, string> } {
  const key = (body as { idempotency_key?: unknown }).idempotency_key;
  if (typeof key !== "string" || key.length === 0) return options;
  return { ...options, headers: { ...options.headers, "idempotency-key": key } };
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
          { param: { appId: input.appId, environmentId: input.environmentId } },
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
    create: (input, callOptions) =>
      invokeHcRoute<ExperimentsCreateOutput>("experiments_create", () =>
        hcClient.apps[":appId"].envs[":environmentId"].experiments.$post(
          {
            param: { appId: input.appId, environmentId: input.environmentId },
            json: input,
          } as never,
          withIdempotencyHeader(hcRequestOptions(withAuthorization(hcOptions, callOptions)), input),
        ),
      ),
    get: (input, callOptions) =>
      invokeHcRoute<ExperimentsGetOutput>("experiments_get", () =>
        hcClient.apps[":appId"].envs[":environmentId"].experiments[":experimentId"].$get(
          {
            param: {
              appId: input.appId,
              environmentId: input.environmentId,
              experimentId: input.experimentId,
            },
          },
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
    update: (input, callOptions) => {
      const { appId, environmentId, experimentId, ...body } = input;
      return invokeHcRoute<ExperimentsUpdateOutput>("experiments_update", () =>
        hcClient.apps[":appId"].envs[":environmentId"].experiments[":experimentId"].$patch(
          { param: { appId, environmentId, experimentId }, json: body } as never,
          withIdempotencyHeader(hcRequestOptions(withAuthorization(hcOptions, callOptions)), body),
        ),
      );
    },
    start: (input, callOptions) => {
      const { appId, environmentId, experimentId, ...body } = input;
      return invokeHcRoute<ExperimentsStartOutput>("experiments_start", () =>
        hcClient.apps[":appId"].envs[":environmentId"].experiments[":experimentId"].start.$post(
          { param: { appId, environmentId, experimentId }, json: body } as never,
          withIdempotencyHeader(hcRequestOptions(withAuthorization(hcOptions, callOptions)), body),
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
          },
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
  };
}
