import type {
  ApiKeysCreateInput,
  ApiKeysCreateOutput,
  ApiKeysListInput,
  ApiKeysListOutput,
  ApiKeysRevokeInput,
  ApiKeysRevokeOutput,
  ClientKeyGetInput,
  ClientKeyGetOutput,
  ClientKeyRotateInput,
  ClientKeyRotateOutput,
  ClientKeyUpdateInput,
  ClientKeyUpdateOutput,
} from "@splitch/contracts/route-types";
import { environmentSelectorQuery } from "./environment-selector-query";
import {
  type ControlPlaneHcOptions,
  type CredentialsHcClient,
  createCredentialsHcClient,
  hcRequestOptions,
  withAuthorization,
} from "./hc-client";
import { invokeHcRoute } from "./hc-invoke";
import type { ControlPlaneOperationOptions, ControlPlaneOperationResult } from "./operation-result";

/**
 * SDK credentials, per Environment (ADR-0027).
 *
 * Provision-don't-read (ADR-0022): there is deliberately NO method that reads an
 * existing API Key's secret, because no endpoint exposes one. The raw secret
 * rides `create`'s response `value` exactly once; `list` returns the APIKey leaf,
 * which carries no key-material field at all. A caller that loses the secret
 * mints a new key — it cannot recover the old one through this client.
 *
 * The public Client Key is different in kind: it is safe to ship, so `clientKey.get`
 * legitimately returns its `keyMaterial`, and `clientKey.rotate` returns the
 * replacement's material alongside the id it revoked.
 */
export interface CredentialsClient {
  readonly clientKey: {
    get(
      input: ClientKeyGetInput,
      options?: ControlPlaneOperationOptions,
    ): Promise<ControlPlaneOperationResult<ClientKeyGetOutput>>;
    update(
      input: ClientKeyUpdateInput,
      options?: ControlPlaneOperationOptions,
    ): Promise<ControlPlaneOperationResult<ClientKeyUpdateOutput>>;
    rotate(
      input: ClientKeyRotateInput,
      options?: ControlPlaneOperationOptions,
    ): Promise<ControlPlaneOperationResult<ClientKeyRotateOutput>>;
  };
  readonly apiKeys: {
    list(
      input: ApiKeysListInput,
      options?: ControlPlaneOperationOptions,
    ): Promise<ControlPlaneOperationResult<ApiKeysListOutput>>;
    create(
      input: ApiKeysCreateInput,
      options?: ControlPlaneOperationOptions,
    ): Promise<ControlPlaneOperationResult<ApiKeysCreateOutput>>;
    revoke(
      input: ApiKeysRevokeInput,
      options?: ControlPlaneOperationOptions,
    ): Promise<ControlPlaneOperationResult<ApiKeysRevokeOutput>>;
  };
}

export function createCredentialsClient(
  hcOptions: ControlPlaneHcOptions,
  client?: CredentialsHcClient,
): CredentialsClient {
  const hcClient = client ?? createCredentialsHcClient(hcOptions);

  return {
    clientKey: {
      get: (input, callOptions) =>
        invokeHcRoute<ClientKeyGetOutput>("client_key_get", () =>
          hcClient.apps[":appId"].envs[":environmentId"]["client-key"].$get(
            {
              param: { appId: input.appId, environmentId: input.environmentId },
              ...environmentSelectorQuery(input),
            } as never,
            hcRequestOptions(withAuthorization(hcOptions, callOptions)),
          ),
        ),
      update: (input, callOptions) => {
        const { appId, environmentId, by, ...body } = input;
        return invokeHcRoute<ClientKeyUpdateOutput>("client_key_update", () =>
          hcClient.apps[":appId"].envs[":environmentId"]["client-key"].$patch(
            {
              param: { appId, environmentId },
              ...environmentSelectorQuery({ by }),
              json: body,
            } as never,
            hcRequestOptions(withAuthorization(hcOptions, callOptions)),
          ),
        );
      },
      rotate: (input, callOptions) =>
        invokeHcRoute<ClientKeyRotateOutput>("client_key_rotate", () =>
          hcClient.apps[":appId"].envs[":environmentId"]["client-key"].revoke.$post(
            {
              param: { appId: input.appId, environmentId: input.environmentId },
              ...environmentSelectorQuery(input),
            } as never,
            hcRequestOptions(withAuthorization(hcOptions, callOptions)),
          ),
        ),
    },
    apiKeys: {
      list: (input, callOptions) =>
        invokeHcRoute<ApiKeysListOutput>("api_keys_list", () =>
          hcClient.apps[":appId"].envs[":environmentId"]["api-keys"].$get(
            {
              param: { appId: input.appId, environmentId: input.environmentId },
              ...environmentSelectorQuery(input),
            } as never,
            hcRequestOptions(withAuthorization(hcOptions, callOptions)),
          ),
        ),
      create: (input, callOptions) => {
        const { appId, environmentId, by, ...body } = input;
        return invokeHcRoute<ApiKeysCreateOutput>("api_keys_create", () =>
          hcClient.apps[":appId"].envs[":environmentId"]["api-keys"].$post(
            {
              param: { appId, environmentId },
              ...environmentSelectorQuery({ by }),
              json: body,
            } as never,
            hcRequestOptions(withAuthorization(hcOptions, callOptions)),
          ),
        );
      },
      revoke: (input, callOptions) =>
        invokeHcRoute<ApiKeysRevokeOutput>("api_keys_revoke", () =>
          hcClient.apps[":appId"].envs[":environmentId"]["api-keys"][":keyId"].revoke.$post(
            {
              param: {
                appId: input.appId,
                environmentId: input.environmentId,
                keyId: input.keyId,
              },
              ...environmentSelectorQuery(input),
              json: {},
            } as never,
            hcRequestOptions(withAuthorization(hcOptions, callOptions)),
          ),
        ),
    },
  };
}
