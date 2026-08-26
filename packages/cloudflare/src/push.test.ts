import { env, SELF } from "cloudflare:test";
import { CLOUDFLARE_SNAPSHOT_MAX_BODY_BYTES } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { baseSnapshot, configurationPushFixture } from "./worker-test-fixtures";

const { push } = configurationPushFixture(env.SPLITCH_PUSH_SECRET, SELF.fetch);

describe("Splitch Cloudflare configuration push", () => {
  it("rejects an oversized streamed snapshot before buffering the complete body", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(CLOUDFLARE_SNAPSHOT_MAX_BODY_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const response = await SELF.fetch("https://worker.test/integrations/splitch/configuration", {
      method: "POST",
      body,
    });
    expect(response.status).toBe(413);
  });

  it("fails evaluations as stale until an announced snapshot is applied", async () => {
    const staleSnapshot = { ...baseSnapshot, environmentVersion: 100 };
    await push(staleSnapshot, "00000000-0000-4000-8000-000000000014");
    const state = env.SPLITCH_STATE.getByName(env.SPLITCH_INSTALLATION_ID);
    await expect(state.announceSnapshot("app_1", "env_other", 101)).resolves.toEqual({
      ok: false,
      reason: "scope_mismatch",
    });
    await expect(
      state.evaluateDetails("checkout", {
        targetingKey: "person_1",
        idempotencyKey: "cross-scope-announcement",
      }),
    ).resolves.toMatchObject({ value: false, variantName: "control" });
    await expect(state.announceSnapshot("app_1", "env_1", 101)).resolves.toEqual({ ok: true });
    await expect(
      state.evaluateDetails("checkout", {
        targetingKey: "person_1",
        idempotencyKey: "known-stale",
      }),
    ).resolves.toMatchObject({
      value: false,
      variantName: null,
      reason: "STALE",
      errorCode: "PROVIDER_NOT_READY",
    });

    await push(
      { ...staleSnapshot, environmentVersion: 101 },
      "00000000-0000-4000-8000-000000000015",
    );
    await expect(
      state.evaluateDetails("checkout", {
        targetingKey: "person_1",
        idempotencyKey: "applied-after-stale",
      }),
    ).resolves.toMatchObject({ value: false, variantName: "control" });
  });
});
