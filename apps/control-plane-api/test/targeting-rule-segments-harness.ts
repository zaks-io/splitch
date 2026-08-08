import { flagConfigKey } from "@splitch/contracts";
import { appScope } from "@splitch/db";
import { afterEach, beforeEach } from "vitest";
import { narrowSeededAvailability } from "../src/config-store-fixture-data";
import { type Harness, ids, NOW, token } from "../src/config-store-harness-core";
import { makePoolHarness } from "./config-store-pool-harness";

export { ids, NOW };

export let h: Harness;

export function useTargetingRuleSegmentsHarness() {
  beforeEach(async () => {
    h = await makePoolHarness();
    await narrowSeededAvailability(h.d1);
  });

  afterEach(async () => {
    await h.dispose();
  });
}

export function segmentRule(segmentId: string | undefined, id = "rule_segment_paid") {
  return {
    id,
    flagId: ids.flagId,
    priority: 0,
    conditions: [],
    ...(segmentId ? { segmentId } : {}),
    variantId: ids.treatmentVariantId,
    percentageRollout: null,
  };
}

export async function seedSegment(id: string, plan: string) {
  await h.repo.flags.segments.insert(appScope(ids.appId), {
    id,
    appId: ids.appId,
    name: "Paid plan",
    conditions: JSON.stringify([{ attribute: "plan", operator: "eq", value: plan }]),
    createdAt: NOW,
    updatedAt: NOW,
  });
}

export async function replaceRules(environmentId: string, rule: object, suffix: string) {
  return request(
    "PUT",
    `/apps/${ids.appId}/envs/${environmentId}/flags/${ids.flagId}/targeting-rules`,
    {
      targetingRules: [rule],
      idempotency_key: `segment_rules_${suffix}`,
    },
    `segment_rules_${suffix}`,
  );
}

export async function segmentRequest(method: "PATCH" | "DELETE", segmentId: string, body?: object) {
  const idempotencyKey =
    body && "idempotency_key" in body && typeof body.idempotency_key === "string"
      ? body.idempotency_key
      : undefined;
  return request(method, `/apps/${ids.appId}/segments/${segmentId}`, body, idempotencyKey);
}

export async function request(
  method: string,
  path: string,
  body?: object,
  idempotencyKey?: string,
) {
  const jwt = await token(h.signer);
  return h.app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

export async function kvFlag(environmentId: string) {
  const raw = await h.kv.get(flagConfigKey(ids.appId, environmentId, ids.flagKey), "json");
  if (!raw || typeof raw !== "object" || !("data" in raw)) throw new Error("KV Flag missing");
  return raw.data as { targetingRules: Array<{ conditions: unknown[] }> };
}
