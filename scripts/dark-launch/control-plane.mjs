/**
 * Control Plane HTTP helpers for the dark-launch journey (no D1/KV/Tinybird).
 */

import { DEFAULT_VARIANT, LAUNCH_VARIANT } from "./constants.mjs";

export async function controlPlaneCall(deps, method, path, body, idempotencyKey) {
  const headers = {
    authorization: `Bearer ${deps.accessToken}`,
    "content-type": "application/json",
    accept: "application/json",
  };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const response = await deps.fetch(`${deps.controlPlaneBaseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json, ok: response.ok };
}

async function requireOk(result, label) {
  if (!result.ok) {
    throw new Error(`${label} failed with HTTP ${result.status}: ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

async function operation(deps, name, args, httpCall, label = name) {
  if (deps.callTool) return deps.callTool(name, args);
  return requireOk(await httpCall(), label);
}

export async function createDarkLaunchApp(deps, keys) {
  const body = {
    orgId: deps.orgId,
    organizationId: deps.orgId,
    name: keys.appName,
    key: keys.appKey,
    description: "Transient hosted onboarding proof App (SPL-148).",
    idempotency_key: keys.appKey,
  };
  return operation(deps, "apps_create", body, () =>
    controlPlaneCall(deps, "POST", `/orgs/${deps.orgId}/apps`, body),
  );
}

export async function createDarkLaunchFlag(deps, appId, flagKey) {
  const idempotencyKey = `dark-launch-flag-create-${deps.runId}`;
  const body = {
    appId,
    key: flagKey,
    name: flagKey,
    schema: { type: "boolean" },
    variants: [
      { name: LAUNCH_VARIANT, value: true, isDefault: false },
      { name: DEFAULT_VARIANT, value: false, isDefault: true },
    ],
    description: "Transient hosted onboarding proof Flag (SPL-148).",
    idempotency_key: idempotencyKey,
  };
  return operation(deps, "flags_create", body, () =>
    controlPlaneCall(deps, "POST", `/apps/${appId}/flags`, body, idempotencyKey),
  );
}

export async function createWrongAppFlag(deps, appId, flagKey) {
  const idempotencyKey = `dark-launch-wrong-app-flag-${deps.runId}`;
  const body = {
    appId,
    key: flagKey,
    name: `${flagKey} wrong-App proof`,
    schema: { type: "string" },
    variants: [
      { name: "wrong-app-only", value: "wrong-app-only", isDefault: true },
      { name: "journey-decoy", value: "journey-decoy", isDefault: false },
    ],
    description: "Same-key Flag proving Client Keys remain App-scoped.",
    idempotency_key: idempotencyKey,
  };
  return operation(deps, "flags_create", body, () =>
    controlPlaneCall(deps, "POST", `/apps/${appId}/flags`, body, idempotencyKey),
  );
}

export async function getClientKey(deps, appId, environmentId) {
  return operation(deps, "client_key_get", { appId, environmentId }, () =>
    controlPlaneCall(deps, "GET", `/apps/${appId}/envs/${environmentId}/client-key`),
  );
}

export async function rotateClientKey(deps, appId, environmentId) {
  return operation(
    deps,
    "client_key_rotate",
    { appId, environmentId },
    () => controlPlaneCall(deps, "POST", `/apps/${appId}/envs/${environmentId}/client-key/revoke`),
    "client_key_rotate",
  );
}

export async function updateFlagConfig(deps, appId, environmentId, flagId, patch) {
  const state = patch.enabled === true ? "enable" : patch.enabled === false ? "disable" : "update";
  const idempotencyKey = `dark-launch-flag-config-${state}-${deps.runId}`;
  const body = { ...patch, idempotency_key: idempotencyKey };
  const args = { appId, environmentId, flagId, ...body };
  return operation(deps, "flag_config_update", args, () =>
    controlPlaneCall(
      deps,
      "PATCH",
      `/apps/${appId}/envs/${environmentId}/flags/${flagId}/config`,
      body,
      idempotencyKey,
    ),
  );
}

export async function replaceTargetingRules(deps, appId, environmentId, flagId, targetingRules) {
  const idempotencyKey = `dark-launch-targeting-rules-${deps.runId}`;
  const body = { targetingRules, idempotency_key: idempotencyKey };
  const args = { appId, environmentId, flagId, ...body };
  return operation(deps, "flag_targeting_rules_replace", args, () =>
    controlPlaneCall(
      deps,
      "PUT",
      `/apps/${appId}/envs/${environmentId}/flags/${flagId}/targeting-rules`,
      body,
      idempotencyKey,
    ),
  );
}

export async function createExperiment(deps, resources, keys) {
  const idempotencyKey = `dark-launch-experiment-create-${deps.runId}`;
  const body = {
    appId: resources.appId,
    environmentId: resources.environmentId,
    name: `Hosted onboarding ${deps.runId}`,
    key: keys.experimentKey,
    flagId: resources.flagId,
    targetingKey: "targetingKey",
    targetingKeyType: "user",
    metrics: [],
    allocation: { [LAUNCH_VARIANT]: 50, [DEFAULT_VARIANT]: 50 },
    salt: `hosted-onboarding-${deps.runId}`,
    idempotency_key: idempotencyKey,
  };
  return operation(deps, "experiments_create", body, () =>
    controlPlaneCall(
      deps,
      "POST",
      `/apps/${resources.appId}/envs/${resources.environmentId}/experiments`,
      body,
      idempotencyKey,
    ),
  );
}

export async function startExperiment(deps, resources) {
  const idempotencyKey = `dark-launch-experiment-start-${deps.runId}`;
  const body = { idempotency_key: idempotencyKey };
  return operation(
    deps,
    "experiments_start",
    {
      appId: resources.appId,
      environmentId: resources.environmentId,
      experimentId: resources.experimentId,
      ...body,
    },
    () =>
      controlPlaneCall(
        deps,
        "POST",
        `/apps/${resources.appId}/envs/${resources.environmentId}/experiments/${resources.experimentId}/start`,
        body,
        idempotencyKey,
      ),
  );
}

export async function testLiveRunVariant(deps, resources, keys) {
  const body = {
    evaluationContext: {
      targetingKey: keys.targetedKey,
      idType: "user",
      attributes: { cohort: "launch" },
    },
  };
  const args = {
    appId: resources.appId,
    environmentId: resources.environmentId,
    flagId: resources.flagId,
    ...body,
  };
  return operation(deps, "flags_test_eval", args, () =>
    controlPlaneCall(
      deps,
      "POST",
      `/apps/${resources.appId}/envs/${resources.environmentId}/flags/${resources.flagId}/test-eval`,
      body,
    ),
  );
}

export async function endRun(deps, resources) {
  if (!resources.runId) return;
  return operation(
    deps,
    "runs_end",
    {
      appId: resources.appId,
      environmentId: resources.environmentId,
      runId: resources.runId,
      reason: "SPL-148 transient proof cleanup",
    },
    () =>
      controlPlaneCall(
        deps,
        "POST",
        `/apps/${resources.appId}/envs/${resources.environmentId}/runs/${resources.runId}/end`,
        { reason: "SPL-148 transient proof cleanup" },
      ),
  );
}

export async function deleteExperiment(deps, resources) {
  if (!resources.experimentId) return;
  return operation(
    deps,
    "experiments_delete",
    {
      appId: resources.appId,
      environmentId: resources.environmentId,
      experimentId: resources.experimentId,
    },
    () =>
      controlPlaneCall(
        deps,
        "DELETE",
        `/apps/${resources.appId}/envs/${resources.environmentId}/experiments/${resources.experimentId}`,
      ),
  );
}

export async function deleteFlag(deps, appId, flagId) {
  const deleteKey = `dark-launch-flag-delete-${deps.runId}`;
  const args = { appId, flagId, idempotency_key: deleteKey };
  const deletion = deps.callToolResult
    ? await deps.callToolResult("flags_delete", args)
    : await controlPlaneCall(
        deps,
        "DELETE",
        `/apps/${appId}/flags/${flagId}`,
        undefined,
        deleteKey,
      );
  if (deletion.ok) return deletion.body;
  if (deletion.body?.code !== "APPROVAL_REVIEW_REQUIRED") {
    return requireOk(deletion, "flags_delete");
  }

  const approvalRequestId = deletion.body.details?.approvalRequestId;
  if (!approvalRequestId) {
    throw new Error("flags_delete approval response omitted details.approvalRequestId");
  }
  const reviewKey = `dark-launch-flag-delete-review-${deps.runId}`;
  const reviewBody = {
    action: "approve_and_apply",
    idempotency_key: reviewKey,
  };
  const reviewArgs = {
    appId,
    id: approvalRequestId,
    ...reviewBody,
  };
  if (deps.callTool) return deps.callTool("approval_request_reviews_create", reviewArgs);
  return requireOk(
    await controlPlaneCall(
      deps,
      "POST",
      `/apps/${appId}/approval-requests/${approvalRequestId}/reviews`,
      reviewBody,
      reviewKey,
    ),
    "approval_request_reviews_create",
  );
}

export async function deleteApp(deps, appId) {
  return operation(deps, "apps_delete", { appId }, () =>
    controlPlaneCall(deps, "DELETE", `/apps/${appId}`),
  );
}

export async function listFlags(deps, appId) {
  return operation(deps, "flags_list", { appId }, () =>
    controlPlaneCall(deps, "GET", `/apps/${appId}/flags`),
  );
}

export async function listApps(deps, orgId) {
  return operation(deps, "apps_list", { orgId }, () =>
    controlPlaneCall(deps, "GET", `/orgs/${orgId}/apps`),
  );
}

export function clientKeyMaterialFromCreate(created, environmentId) {
  const keys = created.clientKeys ?? [];
  const match = keys.find((key) => key.environmentId === environmentId) ?? keys[0];
  if (!match?.keyMaterial) {
    throw new Error("apps_create did not return clientKeys.keyMaterial");
  }
  return match.keyMaterial;
}
