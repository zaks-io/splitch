import { describe, expect, it } from "vitest";
import type { EvaluationApiEnv } from "./env";
import { evaluationApiHandler } from "./index";

const emptyCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

describe("evaluationApiHandler hosted privacy startup", () => {
  it("fails health when the platform target is missing", async () => {
    await expect(
      evaluationApiHandler.fetch(
        new Request("https://evaluation.test/health") as Parameters<
          typeof evaluationApiHandler.fetch
        >[0],
        {} as EvaluationApiEnv,
        emptyCtx,
      ),
    ).rejects.toThrow(/SPLITCH_PLATFORM_TARGET is required/);
  });

  it("fails health when a hosted target has no privacy root salt", async () => {
    await expect(
      evaluationApiHandler.fetch(
        new Request("https://evaluation.test/health") as Parameters<
          typeof evaluationApiHandler.fetch
        >[0],
        { SPLITCH_PLATFORM_TARGET: "production" } as EvaluationApiEnv,
        emptyCtx,
      ),
    ).rejects.toThrow(/EVALUATION_PRIVACY_SALT/);
  });

  it("fails health when a hosted target has no CONFIG_STORE", async () => {
    await expect(
      evaluationApiHandler.fetch(
        new Request("https://evaluation.test/health") as Parameters<
          typeof evaluationApiHandler.fetch
        >[0],
        {
          SPLITCH_PLATFORM_TARGET: "production",
          EVALUATION_PRIVACY_SALT: "hosted-root-secret",
        } as EvaluationApiEnv,
        emptyCtx,
      ),
    ).rejects.toThrow(/CONFIG_STORE is required/);
  });

  it("serves hosted health when the root salt, CONFIG_STORE writer, and deployed SHA are present", async () => {
    const response = await evaluationApiHandler.fetch(
      new Request("https://evaluation.test/health") as Parameters<
        typeof evaluationApiHandler.fetch
      >[0],
      {
        SPLITCH_PLATFORM_TARGET: "production",
        EVALUATION_PRIVACY_SALT: "hosted-root-secret",
        SPLITCH_DEPLOYED_COMMIT_SHA: "a".repeat(40),
        CONFIG_STORE: {
          get: async () => null,
          put: async () => undefined,
        },
        CONFIG_STORE_WRITER: {
          getByName: () => ({
            putAppIdentityIfAbsent: async (_key: string, value: string) => value,
          }),
        },
      } as unknown as EvaluationApiEnv,
      emptyCtx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, platformTarget: "production" });
  });

  it("serves health on an explicit local target without a hosted salt", async () => {
    const response = await evaluationApiHandler.fetch(
      new Request("https://evaluation.test/health") as Parameters<
        typeof evaluationApiHandler.fetch
      >[0],
      { SPLITCH_PLATFORM_TARGET: "local" } as EvaluationApiEnv,
      emptyCtx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, platformTarget: "local" });
  });
});

describe("evaluationApiHandler per-request claims binding", () => {
  it("throws when EXPOSURE_REDEMPTION_CLAIMS is missing on a non-health request", async () => {
    const env = {
      SPLITCH_PLATFORM_TARGET: "local",
      EXPOSURE_TICKET_KEY: "test-ticket-key",
      // EXPOSURE_REDEMPTION_CLAIMS intentionally omitted
    } as EvaluationApiEnv;

    await expect(
      evaluationApiHandler.fetch(
        new Request("https://evaluation.test/api/sdk/exposures", {
          method: "POST",
        }) as Parameters<typeof evaluationApiHandler.fetch>[0],
        env,
        emptyCtx,
      ),
    ).rejects.toThrow(/evaluation-api: EXPOSURE_REDEMPTION_CLAIMS is required/);
  });

  it("throws when HOLDOVER_WRITE_OUTBOX is missing on a non-health request", async () => {
    const env = {
      SPLITCH_PLATFORM_TARGET: "local",
      EXPOSURE_TICKET_KEY: "test-ticket-key",
      EXPOSURE_REDEMPTION_CLAIMS: {
        idFromName: () => ({ toString: () => "id" }) as DurableObjectId,
        get: () => ({ fetch: async () => new Response("ok") }),
      },
      // HOLDOVER_WRITE_OUTBOX intentionally omitted
    } as unknown as EvaluationApiEnv;

    await expect(
      evaluationApiHandler.fetch(
        new Request("https://evaluation.test/api/sdk/exposures", {
          method: "POST",
        }) as Parameters<typeof evaluationApiHandler.fetch>[0],
        env,
        emptyCtx,
      ),
    ).rejects.toThrow(/evaluation-api: HOLDOVER_WRITE_OUTBOX is required/);
  });
});
