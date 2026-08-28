import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { EvaluationEntrypoint } from "./index";
import {
  appId,
  baseExposure,
  environmentId,
  makeEnv,
  mockTinybirdFetch,
  TestExecutionContext,
  workerRequest,
} from "./test-fixtures";
import type { Env } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Event Ingest hosted configuration", () => {
  it.each([
    { label: "missing", platformTarget: undefined, message: "SPLITCH_PLATFORM_TARGET is required" },
    {
      label: "invalid",
      platformTarget: "staging",
      message: 'SPLITCH_PLATFORM_TARGET "staging" is not a platform target',
    },
  ] as const)("refuses HTTP, delegated, queue delivery, and health when the platform target is $label", async ({
    platformTarget,
    message,
  }) => {
    const fetch = mockTinybirdFetch();
    const env = hostedBindings(platformTarget);
    const ctx = new TestExecutionContext();

    await expect(
      worker.fetch(workerRequest("https://event-ingest.test/health"), env, ctx),
    ).rejects.toThrow(message);

    await expect(
      worker.fetch(
        workerRequest("https://event-ingest.test/api/internal/exposures", {
          method: "POST",
          headers: {
            authorization: "Bearer internal_ingest_secret",
            "content-type": "application/json",
            "x-splitch-app-id": appId,
            "x-splitch-environment-id": environmentId,
          },
          body: JSON.stringify(baseExposure()),
        }),
        env,
        ctx,
      ),
    ).rejects.toThrow(message);

    await expect(
      new EvaluationEntrypoint(ctx, env).fetch(
        workerRequest("https://splitch-event-ingest.internal/api/internal/exposures", {
          method: "POST",
          headers: {
            authorization: "Bearer internal_ingest_secret",
            "content-type": "application/json",
            "x-splitch-app-id": appId,
            "x-splitch-environment-id": environmentId,
          },
          body: JSON.stringify(baseExposure()),
        }),
      ),
    ).rejects.toThrow(message);

    await expect(deliver(env)).rejects.toThrow(message);
    expect(fetch).not.toHaveBeenCalled();
  });
});

function hostedBindings(platformTarget: string | undefined): Env {
  const { SPLITCH_PLATFORM_TARGET: _explicitLocal, ...bindings } = makeEnv();
  return {
    ...bindings,
    SPLITCH_PLATFORM_TARGET: platformTarget,
    TINYBIRD_API_URL: "https://api.us-west-2.aws.tinybird.co",
    TINYBIRD_INGEST_TOKEN: "tb_hosted_secret",
  } as Env;
}

async function deliver(env: Env): Promise<void> {
  if (!worker.queue) {
    throw new Error("Event ingest queue handler is not configured");
  }
  await worker.queue(
    {
      messages: [
        {
          id: "message-hosted-config",
          timestamp: new Date("2026-08-07T00:00:00.000Z"),
          body: { event_id: "event-hosted-config" },
          attempts: 1,
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ],
      queue: "metric-events",
      metadata: { metrics: { backlogCount: 1, backlogBytes: 64 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    },
    env,
    {} as ExecutionContext,
  );
}
