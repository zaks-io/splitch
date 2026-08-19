import { describe, expect, it } from "vitest";
import type { EvaluationApiEnv } from "./env";
import { evaluationApiHandler } from "./index";

const emptyCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

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
