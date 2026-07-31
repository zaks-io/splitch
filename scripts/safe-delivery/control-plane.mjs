/**
 * Control Plane HTTP helpers for the safe-delivery tracer.
 * Only normal product operations: no direct D1/KV/Tinybird writes.
 */

async function controlPlaneCall(deps, method, path, body, idempotencyKey) {
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

export function requireOk(result, label) {
  if (!result.ok) {
    throw new Error(`${label} failed with HTTP ${result.status}: ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

export function requireRefused(result, label) {
  if (result.ok) {
    throw new Error(`${label}: expected a refusal, got HTTP ${result.status}`);
  }
  return result.body;
}

export async function createFlag(deps, appId, flagKey, variants, purpose) {
  const idempotencyKey = `safe-delivery-flag-create-${flagKey}`;
  return requireOk(
    await controlPlaneCall(
      deps,
      "POST",
      `/apps/${appId}/flags`,
      {
        appId,
        key: flagKey,
        name: flagKey,
        schema: { type: "string" },
        variants,
        description: `Transient safe-delivery tracer Flag (SPL-151): ${purpose}.`,
        idempotency_key: idempotencyKey,
      },
      idempotencyKey,
    ),
    "flags_create",
  );
}

export async function getFlagConfig(deps, appId, environmentId, flagId) {
  return requireOk(
    await controlPlaneCall(
      deps,
      "GET",
      `/apps/${appId}/envs/${environmentId}/flags/${flagId}/config`,
    ),
    "flag_config_get",
  );
}

/**
 * Raw PATCH so callers can inspect `approvalRequest` themselves. The kill-switch
 * proof depends on seeing `approvalRequest: null` under a `confirm` Environment,
 * so this helper must never swallow that field.
 */
export async function patchFlagConfig(deps, appId, environmentId, flagId, patch, label) {
  const idempotencyKey = `safe-delivery-flag-config-${label}-${deps.runId}`;
  return controlPlaneCall(
    deps,
    "PATCH",
    `/apps/${appId}/envs/${environmentId}/flags/${flagId}/config`,
    { ...patch, idempotency_key: idempotencyKey },
    idempotencyKey,
  );
}

export async function replaceTargetingRules(
  deps,
  appId,
  environmentId,
  flagId,
  targetingRules,
  label,
) {
  const idempotencyKey = `safe-delivery-targeting-rules-${label}-${deps.runId}`;
  return controlPlaneCall(
    deps,
    "PUT",
    `/apps/${appId}/envs/${environmentId}/flags/${flagId}/targeting-rules`,
    { targetingRules, idempotency_key: idempotencyKey },
    idempotencyKey,
  );
}

/**
 * Promote selected field groups from `fromEnvironmentId` into the target
 * Environment. `review` is the accepted inline confirm gate; omitting it against
 * a gated Environment yields 409 APPROVAL_REVIEW_REQUIRED plus an Approval
 * Request id, which is the operator's diff-inspection surface.
 */
export async function promoteFlagConfig(deps, input) {
  const idempotencyKey =
    input.idempotencyKey ?? `safe-delivery-promote-${input.label}-${deps.runId}`;
  const body = {
    fromEnvironmentId: input.fromEnvironmentId,
    select: input.select,
    idempotency_key: idempotencyKey,
  };
  if (input.review) body.review = input.review;
  return controlPlaneCall(
    deps,
    "POST",
    `/apps/${input.appId}/envs/${input.targetEnvironmentId}/flags/${input.flagId}/promote`,
    body,
    idempotencyKey,
  );
}

export async function getApprovalRequest(deps, appId, approvalRequestId) {
  return requireOk(
    await controlPlaneCall(deps, "GET", `/apps/${appId}/approval-requests/${approvalRequestId}`),
    "approval_requests_get",
  );
}

export async function listApprovalRequests(deps, appId, status) {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return requireOk(
    await controlPlaneCall(deps, "GET", `/apps/${appId}/approval-requests${query}`),
    "approval_requests_list",
  );
}

export async function reviewApprovalRequest(deps, appId, approvalRequestId, action, label) {
  const idempotencyKey = `safe-delivery-review-${label}-${deps.runId}`;
  return controlPlaneCall(
    deps,
    "POST",
    `/apps/${appId}/approval-requests/${approvalRequestId}/reviews`,
    { action, idempotency_key: idempotencyKey },
    idempotencyKey,
  );
}

export async function listFlags(deps, appId) {
  return requireOk(await controlPlaneCall(deps, "GET", `/apps/${appId}/flags`), "flags_list");
}

/** Approval-aware delete: a gated Environment refuses first, then we confirm. */
export async function deleteFlag(deps, appId, flagId, label) {
  const deleteKey = `safe-delivery-flag-delete-${label}-${deps.runId}`;
  const deletion = await controlPlaneCall(
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
  return requireOk(
    await reviewApprovalRequest(
      deps,
      appId,
      approvalRequestId,
      "approve_and_apply",
      `delete-${label}`,
    ),
    "approval_request_reviews_create",
  );
}
