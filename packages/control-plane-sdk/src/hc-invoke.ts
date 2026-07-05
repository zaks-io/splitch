import { getRoute } from "@splitch/contracts";
import type { ControlPlaneHcClient, ControlPlaneHcOptions } from "./hc-client";
import { parseControlPlaneResponse, type ControlPlaneOperationResult } from "./operation-result";

export type HcBranch = {
  apps: {
    [":appId"]: {
      flags: {
        $get: (args: unknown, init?: unknown) => Promise<Response>;
        $post: (args: unknown, init?: unknown) => Promise<Response>;
        [":flagId"]: {
          $get: (args: unknown, init?: unknown) => Promise<Response>;
          $patch: (args: unknown, init?: unknown) => Promise<Response>;
          $delete: (args: unknown, init?: unknown) => Promise<Response>;
        };
      };
      envs: {
        [":environmentId"]: {
          experiments: {
            $get: (args: unknown, init?: unknown) => Promise<Response>;
            $post: (args: unknown, init?: unknown) => Promise<Response>;
            [":experimentId"]: {
              $get: (args: unknown, init?: unknown) => Promise<Response>;
              $patch: (args: unknown, init?: unknown) => Promise<Response>;
              $delete: (args: unknown, init?: unknown) => Promise<Response>;
              start: {
                $post: (args: unknown, init?: unknown) => Promise<Response>;
              };
            };
          };
        };
      };
    };
  };
};

export async function invokeHcRoute<T>(
  client: ControlPlaneHcClient,
  _hcOptions: ControlPlaneHcOptions,
  operationId: string,
  call: (branch: HcBranch, requestOptions: Record<string, never>) => Promise<Response>,
): Promise<ControlPlaneOperationResult<T>> {
  const route = getRoute(operationId);
  if (!route) {
    throw new Error(`control-plane-sdk: unknown operation "${operationId}"`);
  }

  const response = await call(client as unknown as HcBranch, {});
  return parseControlPlaneResponse<T>(
    response,
    operationId,
    route.output as { safeParse(input: unknown): { success: true; data: T } | { success: false } },
  );
}
