import type { AppsCreateInput, AppsCreateOutput } from "@splitch/contracts/route-types";
import {
  type AppsHcClient,
  type ControlPlaneHcOptions,
  createAppsHcClient,
  hcRequestOptions,
  withAuthorization,
} from "./hc-client";
import { invokeAppsHcRoute } from "./hc-invoke";
import type { ControlPlaneOperationOptions, ControlPlaneOperationResult } from "./operation-result";

export interface AppsClient {
  create(
    input: AppsCreateInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<AppsCreateOutput>>;
}

export function createAppsClient(
  hcOptions: ControlPlaneHcOptions,
  client?: AppsHcClient,
): AppsClient {
  const hcClient = client ?? createAppsHcClient(hcOptions);

  return {
    create: (input, callOptions) => {
      const { orgId, ...body } = input;
      const options = withAuthorization(hcOptions, callOptions);
      return invokeAppsHcRoute<AppsCreateOutput>(
        hcClient,
        options,
        "apps_create",
        (client, requestOptions) =>
          client.orgs[":orgId"].apps.$post({ param: { orgId }, json: body } as never, {
            ...requestOptions,
            ...hcRequestOptions(options),
          }),
      );
    },
  };
}
