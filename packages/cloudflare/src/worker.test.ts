import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacHex } from "./crypto";

const baseSnapshot = {
  schemaVersion: 1 as const,
  environmentVersion: 1,
  appId: "app_1",
  environmentId: "env_1",
  flags: [
    {
      id: "flag_1",
      key: "checkout",
      environmentId: "env_1",
      experimentId: null,
      enabled: true,
      defaultVariantId: "control",
      variants: [
        { id: "control", name: "control", value: false },
        { id: "treatment", name: "treatment", value: true },
      ],
      availableVariantNames: ["control", "treatment"],
      targetingRules: [],
      rollout: null,
      updatedAt: "2026-08-25T00:00:00.000Z",
    },
  ],
  experiments: [],
  runs: [],
};

const experimentSnapshot = {
  ...baseSnapshot,
  environmentVersion: 2,
  flags: [{ ...baseSnapshot.flags[0], experimentId: "exp_1" }],
  experiments: [
    {
      id: "exp_1",
      environmentId: "env_1",
      flagId: "flag_1",
      targetingKey: "userId",
      targetingKeyType: "user",
      status: "running" as const,
      liveRunId: "run_1",
    },
  ],
  runs: [
    {
      id: "run_1",
      experimentId: "exp_1",
      salt: "stable-salt",
      allocation: { control: 50, treatment: 50 },
      variantSet: baseSnapshot.flags[0].variants,
      targetingRules: [],
      configHash: "sha256:run-1",
      startedAt: "2026-08-25T00:00:00.000Z",
    },
  ],
};

describe("Splitch Cloudflare Worker", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.unstubAllGlobals());

  it("accepts signed monotonic snapshots and evaluates Flags and Experiments locally", async () => {
    await expect(push(baseSnapshot, "00000000-0000-4000-8000-000000000001")).resolves.toMatchObject(
      {
        status: 204,
      },
    );
    const state = env.SPLITCH_STATE.getByName(env.SPLITCH_INSTALLATION_ID);
    await expect(
      state.evaluateDetails("checkout", {
        targetingKey: "person_1",
        idempotencyKey: "ordinary-flag",
      }),
    ).resolves.toMatchObject({ value: false, variantName: "control" });

    await expect(
      push(experimentSnapshot, "00000000-0000-4000-8000-000000000002"),
    ).resolves.toMatchObject({ status: 204 });
    const details = await state.evaluateDetails("checkout", {
      targetingKey: "person_1",
      idempotencyKey: "live-experiment",
    });
    expect(details).toMatchObject({ reason: "SPLIT" });
    await expect(state.status()).resolves.toMatchObject({
      appliedEnvironmentVersion: 2,
      pendingExposureCount: 1,
    });
  });

  it("rejects invalid signatures and cross-scope snapshots", async () => {
    const invalid = await SELF.fetch(`https://worker.test/integrations/splitch/configuration`, {
      method: "POST",
      headers: await signedHeaders("{}", "00000000-0000-4000-8000-000000000003", "invalid"),
      body: "{}",
    });
    expect(invalid.status).toBe(401);

    await push(baseSnapshot, "00000000-0000-4000-8000-000000000004");
    const crossed = await push(
      {
        ...baseSnapshot,
        environmentVersion: 2,
        environmentId: "env_other",
        flags: [{ ...baseSnapshot.flags[0], environmentId: "env_other" }],
      },
      "00000000-0000-4000-8000-000000000005",
    );
    expect(crossed.status).toBe(403);
  });

  it("rejects malformed snapshots and ignores duplicate or stale versions", async () => {
    await push(experimentSnapshot, "00000000-0000-4000-8000-000000000006");
    const malformedBody = "{";
    const malformed = await SELF.fetch(`https://worker.test/integrations/splitch/configuration`, {
      method: "POST",
      headers: await signedHeaders(malformedBody, "00000000-0000-4000-8000-000000000007"),
      body: malformedBody,
    });
    expect(malformed.status).toBe(400);

    await expect(push(baseSnapshot, "00000000-0000-4000-8000-000000000008")).resolves.toMatchObject(
      { status: 204 },
    );
    await expect(
      push(experimentSnapshot, "00000000-0000-4000-8000-000000000006"),
    ).resolves.toMatchObject({ status: 204 });
    await expect(
      env.SPLITCH_STATE.getByName(env.SPLITCH_INSTALLATION_ID).status(),
    ).resolves.toMatchObject({ appliedEnvironmentVersion: 2 });
  });

  it("replays identical evaluations and fails loud on idempotency conflicts", async () => {
    await push(experimentSnapshot, "00000000-0000-4000-8000-000000000009");
    const state = env.SPLITCH_STATE.getByName(env.SPLITCH_INSTALLATION_ID);
    const context = { targetingKey: "person_1", idempotencyKey: "stable-evaluation" };
    const first = await state.evaluateDetails("checkout", context);

    await push(
      { ...experimentSnapshot, environmentVersion: 3 },
      "00000000-0000-4000-8000-000000000011",
    );
    await expect(state.evaluateDetails("checkout", context)).resolves.toEqual(first);
    const conflict = await runInDurableObject(state, async (instance) => {
      try {
        await instance.evaluateDetails("checkout", { ...context, targetingKey: "person_2" });
        return null;
      } catch (cause) {
        return String(cause);
      }
    });
    expect(conflict).toMatch(/IDEMPOTENCY_KEY_CONFLICT/);
    await expect(state.status()).resolves.toMatchObject({ pendingExposureCount: 1 });
  });

  it("retains retryable Exposures until an alarm delivery is accepted", async () => {
    await push(experimentSnapshot, "00000000-0000-4000-8000-000000000010");
    const state = env.SPLITCH_STATE.getByName(env.SPLITCH_INSTALLATION_ID);
    await state.evaluateDetails("checkout", {
      targetingKey: "person_1",
      idempotencyKey: "retryable-exposure",
    });
    const delivery = vi.fn<typeof fetch>();
    delivery.mockResolvedValueOnce(new Response("not json", { status: 202 }));
    delivery.mockImplementationOnce(async (_request, init) => {
      const body = JSON.parse(String(init?.body)) as { exposures: Array<{ exposureId: string }> };
      return Response.json({
        results: [{ exposureId: body.exposures[0]?.exposureId, status: "accepted" }],
      });
    });
    vi.stubGlobal("fetch", delivery);

    await makePendingExposuresDue(state);
    await expect(runDurableObjectAlarm(state)).resolves.toBe(true);
    expect(delivery).toHaveBeenCalledTimes(1);
    await expect(state.status()).resolves.toMatchObject({ pendingExposureCount: 1 });
    await makePendingExposuresDue(state);
    await expect(runDurableObjectAlarm(state)).resolves.toBe(true);
    expect(delivery).toHaveBeenCalledTimes(2);
    await expect(state.status()).resolves.toMatchObject({ pendingExposureCount: 0 });
  });
});

async function makePendingExposuresDue(state: DurableObjectStub): Promise<void> {
  await runInDurableObject(state, (_instance, durableState) => {
    durableState.storage.sql.exec(
      "UPDATE exposure_outbox SET next_attempt_at = 0 WHERE state = 'pending'",
    );
  });
}

async function push(snapshot: unknown, deliveryId: string): Promise<Response> {
  const body = JSON.stringify(snapshot);
  return SELF.fetch(`https://worker.test/integrations/splitch/configuration`, {
    method: "POST",
    headers: await signedHeaders(body, deliveryId),
    body,
  });
}

async function signedHeaders(body: string, deliveryId: string, signature?: string) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const digest =
    signature ?? (await hmacHex(env.SPLITCH_PUSH_SECRET, `${timestamp}.${deliveryId}.${body}`));
  return {
    "content-type": "application/json",
    "splitch-delivery-id": deliveryId,
    "splitch-timestamp": timestamp,
    "splitch-signature": `v1=${digest}`,
  };
}
