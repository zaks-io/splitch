import type {
  OrganizationsCreateInput,
  OrganizationsCreateOutput,
} from "@splitch/contracts/route-types";
import {
  type ControlPlaneHcOptions,
  createOrgsHcClient,
  hcRequestOptions,
  type OrgsHcClient,
  withAuthorization,
} from "./hc-client";
import { invokeHcRoute } from "./hc-invoke";
import type { ControlPlaneOperationOptions, ControlPlaneOperationResult } from "./operation-result";

/**
 * Organization routes the Panel SDK reaches directly (SPL-171).
 *
 * Only `create` lives here: it is the one Organization operation with no `:orgId`
 * to bind against, so it cannot go through the Panel's binding-delegation path
 * like the rest of the Organization surface does.
 */
export interface OrgsClient {
  create(
    input: OrganizationsCreateInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<OrganizationsCreateOutput>>;
}

export function createOrgsClient(
  hcOptions: ControlPlaneHcOptions,
  client?: OrgsHcClient,
): OrgsClient {
  const hcClient = client ?? createOrgsHcClient(hcOptions);

  return {
    create: (input, callOptions) =>
      invokeHcRoute<OrganizationsCreateOutput>("organizations_create", () =>
        hcClient.orgs.$post(
          { json: input } as never,
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
  };
}
