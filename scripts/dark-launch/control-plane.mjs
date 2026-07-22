/**
 * Control Plane HTTP helpers for the dark-launch journey (no D1/KV/Tinybird).
 */

import { DEFAULT_VARIANT, LAUNCH_VARIANT } from "./constants.mjs";

export async function controlPlaneCall(deps, method, path, body) {
  const response = await deps.fetch(`${deps.controlPlaneBaseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${deps.accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
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

export async function requireOk(result, label) {
  if (!result.ok) {
    throw new Error(
      `${label} failed with HTTP ${result.status}: ${JSON.stringify(result.body)}`,
    );
  }
  return result.body;
}

export async function createDarkLaunchApp(deps, keys) {
  return requireOk(
    await controlPlaneCall(deps, "POST", `/orgs/${deps.orgId}/apps`, {
      orgId: deps.orgId,
      organizationId: deps.orgId,
      name: keys.appName,
      key: keys.appKey,
      description: "Transient dark-launch smoke App (SPL-168).",
      idempotency_key: keys.appKey,
    }),
    "apps_create",
  );
}

export async function createDarkLaunchFlag(deps, appId, flagKey) {
  return requireOk(
    await controlPlaneCall(deps, "POST", `/apps/${appId}/flags`, {
      appId,
      key: flagKey,
      name: flagKey,
      schema: { type: "boolean" },
      variants: [
        { name: LAUNCH_VARIANT, value: true, isDefault: false },
        { name: DEFAULT_VARIANT, value: false, isDefault: true },
      ],
      description: "Transient dark-launch smoke Flag (SPL-168).",
    }),
    "flags_create",
  );
}

export async function getClientKey(deps, appId, environmentId) {
  return requireOk(
    await controlPlaneCall(deps, "GET", `/apps/${appId}/envs/${environmentId}/client-key`),
    "client_key_get",
  );
}

export async function rotateClientKey(deps, appId, environmentId) {
  return requireOk(
    await controlPlaneCall(deps, "POST", `/apps/${appId}/envs/${environmentId}/client-key/revoke`),
    "client_key_rotate",
  );
}

export async function updateFlagConfig(deps, appId, environmentId, flagId, patch) {
  return requireOk(
    await controlPlaneCall(
      deps,
      "PATCH",
      `/apps/${appId}/envs/${environmentId}/flags/${flagId}/config`,
      patch,
    ),
    "flag_config_update",
  );
}

export async function replaceTargetingRules(deps, appId, environmentId, flagId, targetingRules) {
  return requireOk(
    await controlPlaneCall(
      deps,
      "PUT",
      `/apps/${appId}/envs/${environmentId}/flags/${flagId}/targeting-rules`,
      { targetingRules },
    ),
    "flag_targeting_rules_replace",
  );
}

export async function deleteFlag(deps, appId, flagId) {
  return requireOk(
    await controlPlaneCall(deps, "DELETE", `/apps/${appId}/flags/${flagId}`),
    "flags_delete",
  );
}

export async function deleteApp(deps, appId) {
  return requireOk(await controlPlaneCall(deps, "DELETE", `/apps/${appId}`), "apps_delete");
}

export async function listFlags(deps, appId) {
  return requireOk(await controlPlaneCall(deps, "GET", `/apps/${appId}/flags`), "flags_list");
}

export async function listApps(deps, orgId) {
  return requireOk(await controlPlaneCall(deps, "GET", `/orgs/${orgId}/apps`), "apps_list");
}

export function clientKeyMaterialFromCreate(created, environmentId) {
  const keys = created.clientKeys ?? [];
  const match = keys.find((key) => key.environmentId === environmentId) ?? keys[0];
  if (!match?.keyMaterial) {
    throw new Error("apps_create did not return clientKeys.keyMaterial");
  }
  return match.keyMaterial;
}
