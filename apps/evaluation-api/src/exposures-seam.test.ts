import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CURRENT_KV_SCHEMA_VERSION, experimentConfigKey, runConfigKey } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AssembledExposure } from "./evaluate/exposure-assembly";
import { makeHttpExposureIngestSink } from "./exposure-redemption";
import { EXPOSURE_ID_A, exposuresInit, mintTicket, PATH } from "./exposures-test-fixtures";
import {
  APP_ID,
  CLIENT_KEY,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  makeSdkRouteHarness,
} from "./sdk-route-test-fixtures";

/**
 * Drives a sealed AssembledExposure through the real Event Ingest Worker
 * (`POST /api/internal/exposures`), not an in-process recorder of the append
 * boundary. Dynamic import keeps deploy-unit boundaries for production code.
 */
describe("POST /api/sdk/exposures: real Event Ingest seam", () => {
  it("accepts a batch whose sealed Exposure appends via /api/internal/exposures", async () => {
    const tinybird = mockTinybirdFetch();
    const eventIngest = await loadEventIngestWorker();
    const env = makeEventIngestEnv();
    const ctx = new TestExecutionContext();
    const httpSink = makeHttpExposureIngestSink({
      token: "internal_ingest_secret",
      endpoint: "https://event-ingest.test",
      fetcher: {
        fetch: (input, init) =>
          eventIngest.fetch(new Request(input, init) as never, env as never, ctx as never),
      },
    });
    const recording = new RecordingDownstream();
    const exposureIngestSink = {
      async write(exposure: AssembledExposure) {
        recording.writes.push(exposure);
        await httpSink.write(exposure);
      },
    };

    const { app, assignmentStore } = await makeSdkRouteHarness({
      liveRun: true,
      exposureIngestSink,
    });
    const ticket = await mintTicket();
    const res = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
    );
    await Promise.all(ctx.waits);

    expect(res.status).toBe(202);
    expect(((await res.json()) as { results: unknown[] }).results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "accepted", code: null },
    ]);
    expect(recording.writes).toHaveLength(1);
    expect(tinybird).toHaveBeenCalled();
    const row = JSON.parse(String(tinybird.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(row).toMatchObject({
      app_id: APP_ID,
      environment_id: ENVIRONMENT_ID,
      experiment_id: EXPERIMENT_ID,
      run_id: "run-42",
      event_id: EXPOSURE_ID_A,
      variant: "treatment",
      type: "exposure",
    });
    expect(assignmentStore.putHashedCalls).toHaveLength(1);
  });
});

class RecordingDownstream {
  readonly writes: AssembledExposure[] = [];
}

class TestExecutionContext implements ExecutionContext {
  readonly exports: Cloudflare.Exports = {};
  readonly props = {};
  readonly tracing = {} as Tracing;
  waits: Promise<unknown>[] = [];
  waitUntil(promise: Promise<unknown>): void {
    this.waits.push(promise);
  }
  passThroughOnException(): void {}
}

function mockTinybirdFetch() {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function loadEventIngestWorker(): Promise<{
  fetch: (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
}> {
  const href = pathToFileURL(join(process.cwd(), "../event-ingest-api/src/index.ts")).href;
  const mod = (await import(href)) as {
    EvaluationEntrypoint: new (
      ctx: ExecutionContext,
      env: unknown,
    ) => { fetch(request: Request): Promise<Response> };
  };
  return {
    fetch(request, env, ctx) {
      return new mod.EvaluationEntrypoint(ctx, env).fetch(request);
    },
  };
}

function makeEventIngestEnv() {
  const kv = new MemoryKV();
  kv.set(
    experimentConfigKey(APP_ID, ENVIRONMENT_ID, EXPERIMENT_ID),
    envelope({
      id: EXPERIMENT_ID,
      environmentId: ENVIRONMENT_ID,
      flagId: "flag_checkout",
      targetingKey: "userId",
      targetingKeyType: "user",
      status: "running",
      liveRunId: "run-42",
    }),
  );
  kv.set(
    runConfigKey(APP_ID, ENVIRONMENT_ID, "run-42"),
    envelope({
      id: "run-42",
      experimentId: EXPERIMENT_ID,
      salt: "run-salt",
      allocation: { control: 50, treatment: 50 },
      variantSet: [
        { id: "var_control", name: "control", value: false },
        { id: "var_treatment", name: "treatment", value: true },
      ],
      targetingRules: [],
      configHash: "sha256:run-salt",
      startedAt: "2026-07-01T00:00:00.000Z",
    }),
  );
  return {
    CONFIG_STORE: kv as unknown as KVNamespace,
    SPLITCH_PLATFORM_TARGET: "local",
    SPLITCH_EVENT_INGEST_TOKEN: "internal_ingest_secret",
    TINYBIRD_API_URL: "https://tinybird.test",
    TINYBIRD_INGEST_TOKEN: "tb_ingest_secret",
    INGEST_ADMISSION_GATE: allowAllAdmissionGate(),
  };
}

function allowAllAdmissionGate() {
  return {
    idFromName(name: string) {
      return name as unknown as DurableObjectId;
    },
    get() {
      return {
        async fetch() {
          return Response.json({ allowed: true, retryAfterMs: 0 });
        },
      };
    },
  };
}

function envelope(data: unknown) {
  return JSON.stringify({ schemaVersion: CURRENT_KV_SCHEMA_VERSION, data });
}

class MemoryKV {
  readonly values = new Map<string, string>();
  set(key: string, value: string): void {
    this.values.set(key, value);
  }
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
}
