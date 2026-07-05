import { getRoute } from "@splitch/contracts";
import type { ClientResponse } from "hono/client";
import type { ControlPlaneHcOptions, ExperimentsHcClient, FlagsHcClient } from "./hc-client";
import { type ControlPlaneOperationResult, parseControlPlaneResponse } from "./operation-result";

type HcLikeResponse = Pick<Response, "ok" | "status" | "text"> | ClientResponse<unknown>;

export async function invokeFlagsHcRoute<T>(
  client: FlagsHcClient,
  _hcOptions: ControlPlaneHcOptions,
  operationId: string,
  call: (client: FlagsHcClient, requestOptions: Record<string, never>) => Promise<HcLikeResponse>,
): Promise<ControlPlaneOperationResult<T>> {
  const route = getRoute(operationId);
  if (!route) {
    throw new Error(`control-plane-sdk: unknown operation "${operationId}"`);
  }

  const response = await call(client, {});
  return parseControlPlaneResponse<T>(
    response as Response,
    operationId,
    route.output as { safeParse(input: unknown): { success: true; data: T } | { success: false } },
  );
}

export async function invokeExperimentsHcRoute<T>(
  client: ExperimentsHcClient,
  _hcOptions: ControlPlaneHcOptions,
  operationId: string,
  call: (
    client: ExperimentsHcClient,
    requestOptions: Record<string, never>,
  ) => Promise<HcLikeResponse>,
): Promise<ControlPlaneOperationResult<T>> {
  const route = getRoute(operationId);
  if (!route) {
    throw new Error(`control-plane-sdk: unknown operation "${operationId}"`);
  }

  const response = await call(client, {});
  return parseControlPlaneResponse<T>(
    response as Response,
    operationId,
    route.output as { safeParse(input: unknown): { success: true; data: T } | { success: false } },
  );
}
