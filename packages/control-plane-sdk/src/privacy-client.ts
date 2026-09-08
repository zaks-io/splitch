import type { EntityPrivacyInput, EntityPrivacyOutput } from "@splitch/contracts/route-types";
import {
  type ControlPlaneHcOptions,
  createPrivacyHcClient,
  hcRequestOptions,
  type PrivacyHcClient,
  withAuthorization,
} from "./hc-client";
import { invokeHcRoute } from "./hc-invoke";
import { withIdempotencyHeader } from "./idempotency-header";
import type {
  ControlPlaneIdempotentOperationOptions,
  ControlPlaneOperationResult,
} from "./operation-result";

export interface PrivacyClient {
  exportEntity(
    input: EntityPrivacyInput,
    options: ControlPlaneIdempotentOperationOptions,
  ): Promise<ControlPlaneOperationResult<EntityPrivacyOutput>>;
  deleteEntity(
    input: EntityPrivacyInput,
    options: ControlPlaneIdempotentOperationOptions,
  ): Promise<ControlPlaneOperationResult<EntityPrivacyOutput>>;
}

export function createPrivacyClient(
  hcOptions: ControlPlaneHcOptions,
  client?: PrivacyHcClient,
): PrivacyClient {
  const hcClient = client ?? createPrivacyHcClient(hcOptions);
  return {
    exportEntity: (input, callOptions) =>
      invokeEntityPrivacyRoute(
        hcClient,
        hcOptions,
        "entity_privacy_export",
        "export",
        input,
        callOptions,
      ),
    deleteEntity: (input, callOptions) =>
      invokeEntityPrivacyRoute(
        hcClient,
        hcOptions,
        "entity_privacy_delete",
        "delete",
        input,
        callOptions,
      ),
  };
}

function invokeEntityPrivacyRoute(
  hcClient: PrivacyHcClient,
  hcOptions: ControlPlaneHcOptions,
  operationId: "entity_privacy_export" | "entity_privacy_delete",
  action: "export" | "delete",
  input: EntityPrivacyInput,
  callOptions: ControlPlaneIdempotentOperationOptions | undefined,
): Promise<ControlPlaneOperationResult<EntityPrivacyOutput>> {
  const { appId, ...body } = input;
  return invokeHcRoute<EntityPrivacyOutput>(operationId, () =>
    hcClient.apps[":appId"].privacy.entities[action].$post(
      { param: { appId }, json: body } as never,
      withIdempotencyHeader(
        operationId,
        hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        callOptions?.idempotencyKey,
      ),
    ),
  );
}
