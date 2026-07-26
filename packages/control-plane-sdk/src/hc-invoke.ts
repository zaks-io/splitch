import { getRoute } from "@splitch/contracts";
import type { ClientResponse } from "hono/client";
import { type ControlPlaneOperationResult, parseControlPlaneResponse } from "./operation-result";

type HcLikeResponse = Pick<Response, "ok" | "status" | "text"> | ClientResponse<unknown>;

/**
 * Invoke one contract route and parse its response against the registry's output
 * schema — the single path every route group (flags, apps, environments,
 * credentials, experiments) goes through.
 *
 * The caller passes a thunk that already closes over its own typed `hc` client,
 * so this helper needs no client type parameter: each route group keeps full
 * per-route inference at its own call site while sharing one implementation.
 */
export async function invokeHcRoute<Output>(
  operationId: string,
  call: () => Promise<HcLikeResponse>,
): Promise<ControlPlaneOperationResult<Output>> {
  const route = getRoute(operationId);
  if (!route) {
    throw new Error(`control-plane-sdk: unknown operation "${operationId}"`);
  }

  const response = await call();
  return parseControlPlaneResponse<Output>(
    response as Response,
    operationId,
    route.output as {
      safeParse(input: unknown): { success: true; data: Output } | { success: false };
    },
  );
}
