import { appScope, createRepository, envScope } from "@splitch/db";
import { expect } from "vitest";
import { type Harness, ids, patchFlagConfig, token } from "../src/config-store-harness-core";

/** Every Policy gate set to `confirm`: the strictest level the API can write. */
export const confirmPolicy = {
  variantAvailability: "confirm",
  targetingRolloutValue: "confirm",
  enabledState: "confirm",
  startExperimentRun: "confirm",
} as const;

export const allowPolicy = {
  variantAvailability: "allow",
  targetingRolloutValue: "allow",
  enabledState: "allow",
  startExperimentRun: "allow",
} as const;

/**
 * `approve` is reserved for the Approval contract and is not writable through
 * the Environment API, so a stored row carrying it can only have arrived by
 * bypassing that API. Reads of it must fail closed.
 */
export const outOfContractPolicy = {
  variantAvailability: "approve",
  targetingRolloutValue: "approve",
  enabledState: "approve",
  startExperimentRun: "approve",
} as const;

export const NOW_APPROVAL = "2026-07-02T11:22:33.000Z";

export interface PatchOutcome {
  status: number;
  code?: string;
  message?: string;
  approvalRequestId?: string;
}

/** The seeded Flag is controlled by a live Run, which freezes it ahead of any
 * Policy gate. Drop it so the Approval gate is what answers. */
export async function clearFrozenRun(h: Harness): Promise<void> {
  await h.d1.prepare("DELETE FROM runs WHERE app_id = ?").bind(ids.appId).run();
  await h.d1.prepare("DELETE FROM experiments WHERE app_id = ?").bind(ids.appId).run();
}

export async function patchVariant(
  h: Harness,
  name: string,
  key: string,
  body: Record<string, unknown>,
): Promise<PatchOutcome> {
  const jwt = await token(h.signer);
  const response = await h.app.request(`/apps/${ids.appId}/flags/${ids.flagId}/variants/${name}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({ idempotency_key: key, ...body }),
  });
  return outcome(response);
}

export async function createVariantRequest(
  h: Harness,
  key: string,
  body: Record<string, unknown>,
): Promise<PatchOutcome> {
  const jwt = await token(h.signer);
  const response = await h.app.request(`/apps/${ids.appId}/flags/${ids.flagId}/variants`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({ appId: ids.appId, flagId: ids.flagId, idempotency_key: key, ...body }),
  });
  return outcome(response);
}

export async function deleteVariantRequest(
  h: Harness,
  name: string,
  key: string,
): Promise<PatchOutcome> {
  const jwt = await token(h.signer);
  const response = await h.app.request(`/apps/${ids.appId}/flags/${ids.flagId}/variants/${name}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${jwt}`, "idempotency-key": key },
  });
  return outcome(response);
}

async function outcome(response: Response): Promise<PatchOutcome> {
  const parsed = (await response.json()) as {
    code?: string;
    message?: string;
    details?: { approvalRequestId?: string };
  };
  return {
    status: response.status,
    code: parsed.code,
    message: parsed.message,
    approvalRequestId: parsed.details?.approvalRequestId,
  };
}

export async function patchConfig(
  h: Harness,
  key: string,
  body: Record<string, unknown>,
): Promise<PatchOutcome> {
  const jwt = await token(h.signer);
  const response = await h.app.request(
    `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/config`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify({ idempotency_key: key, ...body }),
    },
  );
  return outcome(response);
}

export async function reviewRequest(
  h: Harness,
  requestId: string,
  idempotencyKey: string,
  action: "approve_and_apply" | "decline" = "approve_and_apply",
): Promise<Response> {
  const jwt = await token(h.signer);
  return h.app.request(`/apps/${ids.appId}/approval-requests/${requestId}/reviews`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({ action, idempotency_key: idempotencyKey }),
  });
}

export async function readRequest(
  h: Harness,
  requestId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const jwt = await token(h.signer);
  const response = await h.app.request(`/apps/${ids.appId}/approval-requests/${requestId}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

export async function insertEnvironment(
  h: Harness,
  envId: string,
  policy: Record<string, string>,
): Promise<void> {
  await createRepository(h.d1).identity.environments.insert(appScope(ids.appId), {
    id: envId,
    appId: ids.appId,
    key: envId,
    name: envId,
    policy: JSON.stringify(policy),
    createdAt: NOW_APPROVAL,
    updatedAt: NOW_APPROVAL,
  });
}

export async function insertFlagConfig(h: Harness, envId: string): Promise<void> {
  await createRepository(h.d1).flags.flagConfigs.insert(envScope(ids.appId, envId), {
    id: `flag_config_${envId}`,
    appId: ids.appId,
    environmentId: envId,
    flagId: ids.flagId,
    enabled: true,
    availableVariantNames: JSON.stringify(["control", "treatment"]),
    defaultVariantId: ids.controlVariantId,
    createdAt: NOW_APPROVAL,
    updatedAt: NOW_APPROVAL,
  });
}

export function countApprovalReviews(h: Harness): Promise<number> {
  return h.d1
    .prepare("SELECT COUNT(*) AS n FROM approval_reviews")
    .first<{ n: number }>()
    .then((row) => row?.n ?? 0);
}

/** Tenant A proposal (pending) via the served flag-config PATCH route. */
export async function proposeA(h: Harness): Promise<string> {
  const response = await patchFlagConfig(h, { availableVariantNames: ["control"] });
  expect(response.status).toBe(409);
  const body = (await response.json()) as { code: string; details: { approvalRequestId: string } };
  expect(body.code).toBe("APPROVAL_REVIEW_REQUIRED");
  return body.details.approvalRequestId;
}

/** GET a single Approval Request (by id) or the list (by query string). */
export async function getApprovalRequests(
  h: Harness,
  requestId?: string,
  query = "",
): Promise<Response> {
  const jwt = await token(h.signer);
  const suffix = requestId ? `/${requestId}` : query;
  return h.app.request(`/apps/${ids.appId}/approval-requests${suffix}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
}
