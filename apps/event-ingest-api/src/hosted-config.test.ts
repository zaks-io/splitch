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

    const queued = {
      id: "message-hosted-config",
      timestamp: new Date("2026-08-07T00:00:00.000Z"),
      body: { event_id: "event-hosted-config" },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    if (!worker.queue) {
      throw new Error("Event ingest queue handler is not configured");
    }
    await expect(
      worker.queue(
        {
          messages: [queued],
          queue: "metric-events",
          metadata: { metrics: { backlogCount: 1, backlogBytes: 64 } },
          ackAll: vi.fn(),
          retryAll: vi.fn(),
        },
        env,
        ctx,
      ),
    ).rejects.toThrow(message);
    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(([url]) => String(url)).join()).not.toContain("api.tinybird.co");
  });

  it("fails health when a hosted target has no privacy root salt", async () => {
    const env = hostedBindings("production");
    delete (env as { EVALUATION_PRIVACY_SALT?: string }).EVALUATION_PRIVACY_SALT;

    await expect(
      worker.fetch(
        workerRequest("https://event-ingest.test/health"),
        env,
        new TestExecutionContext(),
      ),
    ).rejects.toThrow(/EVALUATION_PRIVACY_SALT/);
  });

  it("serves hosted health when the root salt and deployed SHA are present", async () => {
    const response = await worker.fetch(
      workerRequest("https://event-ingest.test/health"),
      hostedBindings("production"),
      new TestExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, platformTarget: "production" });
  });

  it("serves health on an explicit local target without a hosted salt", async () => {
    const env = makeEnv();
    delete (env as { EVALUATION_PRIVACY_SALT?: string }).EVALUATION_PRIVACY_SALT;

    const response = await worker.fetch(
      workerRequest("https://event-ingest.test/health"),
      env,
      new TestExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, platformTarget: "local" });
  });
});

function hostedBindings(platformTarget: string | undefined): Env {
  const { SPLITCH_PLATFORM_TARGET: _explicitLocal, ...bindings } = makeEnv();
  return {
    ...bindings,
    SPLITCH_PLATFORM_TARGET: platformTarget,
    TINYBIRD_API_URL: "https://api.us-west-2.aws.tinybird.co",
    TINYBIRD_INGEST_TOKEN: "tb_hosted_secret",
    EVALUATION_PRIVACY_SALT: "hosted-privacy-salt",
    SPLITCH_DEPLOYED_COMMIT_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  } as Env;
}
