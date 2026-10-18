import type { EnvironmentPolicy } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import {
  ALLOW_POLICY,
  type AppEnvironmentDeps,
  type AppRow,
  createEnvironmentRecord,
  type EnvironmentRow,
  environmentResponse,
} from "./app-environment-model";
import {
  type ClientKeyRow,
  clientKeyResponse,
  provisionClientKey,
} from "./client-key-provisioning";
import { environmentCreateConflict } from "./environment-create-conflict";
import {
  initializeFlagConfigsForEnvironment,
  rollbackCreatedEnvironment,
} from "./flag-config-lifecycle";

export async function createPermanentEnvironment(
  deps: AppEnvironmentDeps,
  app: AppRow,
  body: Record<string, unknown>,
  principal: Principal,
  requestId: string,
): Promise<Response> {
  const appId = app.id;
  let environment: EnvironmentRow;
  try {
    environment = await createEnvironmentRecord(deps, appScope(appId), appId, {
      key: body.key as string,
      name: (body.name as string | undefined) ?? (body.key as string),
      policy: (body.policy as EnvironmentPolicy | undefined) ?? ALLOW_POLICY,
      actorId: principal.id,
    });
  } catch (cause) {
    return environmentCreateConflict(cause, body.key as string, requestId);
  }
  let clientKey: ClientKeyRow;
  try {
    await initializeFlagConfigsForEnvironment(deps, appId, environment.id);
    clientKey = await provisionClientKey(deps, {
      appId,
      environmentId: environment.id,
      organizationId: app.organizationId,
      scope: envScope(appId, environment.id),
    });
  } catch (cause) {
    await rollbackCreatedEnvironment(deps, appId, environment.id);
    throw cause;
  }
  // The public Client Key rides the create response so the caller can point an
  // SDK at the new Environment without a second command (ADR-0034, SPL-377).
  // Provisioning failure rolls the Environment back above, so there is no
  // success path that answers without a key.
  return Response.json({
    ...environmentResponse(environment),
    clientKey: clientKeyResponse(clientKey),
  });
}
