import { CURRENT_KV_SCHEMA_VERSION, experimentConfigKey, runConfigKey } from "@splitch/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index.js";

const appId = "app_credential";
const clientAppId = "app_from_client";
const environmentId = "env_prod";
const experimentId = "exp_checkout";
const liveRunId = "run_live";
const fixedNow = "2026-07-01T12:34:56.789Z";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Event Ingest Worker", () => {
  it("appends a validated raw_events row through waitUntil", async () => {
    const calls = await postExposure();
    const row = expectRow(calls.rows);

    expect(calls.response.status).toBe(202);
    expect(calls.fetch).toHaveBeenCalledTimes(1);
    expect(calls.fetch.mock.calls[0]?.[0]).toBe("https://tinybird.test/v0/events?name=raw_events");
    expect(row).toMatchObject({
      app_id: appId,
      environment_id: environmentId,
      experiment_id: experimentId,
      run_id: liveRunId,
      id_type: "user",
      event_id: "evt_retry_1",
      server_received_at: fixedNow,
      ingest_ts: fixedNow,
      client_timestamp: "2026-07-01T12:00:00.000Z",
      variant: "treatment",
      is_holdover: 0,
      counterfactual: 0,
      sdk_version: "sdk-test",
    });
    expect(String(row.dedup_key)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("logs Tinybird waitUntil append failures for Worker observability", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = await postExposure({ tinybirdStatus: 500, awaitWaits: false });

    expect(calls.response.status).toBe(202);
    await expect(Promise.all(calls.ctx.waits)).rejects.toThrow(
      "Tinybird append failed with HTTP 500",
    );
    expect(error).toHaveBeenCalledWith(
      "event-ingest-api Tinybird append failed",
      expect.objectContaining({
        appId,
        eventId: "evt_retry_1",
        errorMessage: "Tinybird append failed with HTTP 500",
      }),
    );
  });

  it("rejects an idType mismatch before Tinybird append", async () => {
    const calls = await postExposure({ payload: { idType: "workspace" } });

    expect(calls.response.status).toBe(400);
    await expect(calls.response.json()).resolves.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls.fetch).not.toHaveBeenCalled();
    expect(calls.ctx.waits).toHaveLength(0);
  });

  it("rejects unauthenticated requests before parsing the body", async () => {
    const fetch = mockTinybirdFetch();
    const ctx = new TestExecutionContext();

    const response = await worker.fetch(
      workerRequest("https://event-ingest.test/api/internal/exposures", {
        method: "POST",
        headers: {
          authorization: "Bearer wrong",
          "content-type": "application/json",
          "x-splitch-app-id": appId,
          "x-splitch-environment-id": environmentId,
        },
        body: "{",
      }),
      makeEnv(),
      ctx,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHORIZED" });
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.waits).toHaveLength(0);
  });

  it("ignores client-supplied appId and environmentId", async () => {
    const calls = await postExposure({
      payload: { appId: clientAppId, environmentId: "env_from_client" },
    });
    const row = expectRow(calls.rows);

    expect(row.app_id).toBe(appId);
    expect(row.environment_id).toBe(environmentId);
  });

  it("keeps event_id and dedup_key stable across retries", async () => {
    const first = await postExposure();
    const second = await postExposure();
    const firstRow = expectRow(first.rows);
    const secondRow = expectRow(second.rows);

    expect(firstRow.event_id).toBe("evt_retry_1");
    expect(secondRow.event_id).toBe("evt_retry_1");
    expect(firstRow.dedup_key).toBe(secondRow.dedup_key);
  });

  it("does not append from peek or test-eval paths", async () => {
    const fetch = mockTinybirdFetch();
    const env = makeEnv();
    const ctx = new TestExecutionContext();

    const peek = await worker.fetch(
      workerRequest("https://event-ingest.test/api/sdk/peek", { method: "POST" }),
      env,
      ctx,
    );
    const testEval = await worker.fetch(
      workerRequest("https://event-ingest.test/apps/app/envs/env/flags/flag/test-eval", {
        method: "POST",
      }),
      env,
      ctx,
    );

    expect(peek.status).toBe(404);
    expect(testEval.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.waits).toHaveLength(0);
  });
});

async function postExposure(
  options: {
    payload?: Partial<ExposurePayload>;
    tinybirdStatus?: number;
    awaitWaits?: boolean;
  } = {},
) {
  vi.spyOn(Date, "now").mockReturnValue(new Date(fixedNow).getTime());
  const fetch = mockTinybirdFetch(options.tinybirdStatus);
  const ctx = new TestExecutionContext();
  const response = await worker.fetch(
    workerRequest("https://event-ingest.test/api/internal/exposures", {
      method: "POST",
      headers: {
        authorization: "Bearer internal_ingest_secret",
        "content-type": "application/json",
        "x-splitch-app-id": appId,
        "x-splitch-environment-id": environmentId,
      },
      body: JSON.stringify({ ...baseExposure(), ...options.payload }),
    }),
    makeEnv(),
    ctx,
  );

  if (options.awaitWaits !== false) await Promise.all(ctx.waits);

  return {
    ctx,
    fetch,
    response,
    rows: fetch.mock.calls.map(
      (call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>,
    ),
  };
}

function baseExposure(): ExposurePayload {
  return {
    dedupKey: "client_dedup_key_is_ignored",
    eventId: "evt_retry_1",
    appId: clientAppId,
    environmentId: "env_from_client",
    experimentId,
    runId: "run_from_client",
    idType: "user",
    targetingKeyHash: "hmac:targeting-key",
    variantName: "treatment",
    type: "exposure",
    sourceId: "pop-sjc",
    counterfactual: false,
    clientTimestamp: "2026-07-01T12:00:00.000Z",
    serverReceivedAt: "2000-01-01T00:00:00.000Z",
    ingestTs: "2000-01-01T00:00:00.000Z",
    sdkVersion: "sdk-test",
  };
}

function makeEnv() {
  return {
    CONFIG_STORE: seededConfigStore() as unknown as KVNamespace,
    SPLITCH_EVENT_INGEST_TOKEN: "internal_ingest_secret",
    TINYBIRD_API_URL: "https://tinybird.test",
    TINYBIRD_INGEST_TOKEN: "tb_ingest_secret",
  };
}

function seededConfigStore() {
  const kv = new MemoryKV();
  kv.set(
    experimentConfigKey(appId, environmentId, experimentId),
    envelope({
      id: experimentId,
      environmentId,
      flagId: "flag_checkout",
      targetingKey: "userId",
      targetingKeyType: "user",
      status: "running",
      liveRunId,
    }),
  );
  kv.set(
    runConfigKey(appId, environmentId, liveRunId),
    envelope({
      id: liveRunId,
      experimentId,
      salt: "run-salt",
      allocation: { control: 50, treatment: 50 },
      variantSet: [
        { id: "var_control", name: "control", value: false },
        { id: "var_treatment", name: "treatment", value: true },
      ],
      targetingRules: [],
      configHash: "sha256:config",
      startedAt: "2026-07-01T00:00:00.000Z",
    }),
  );
  return kv;
}

function envelope(data: unknown) {
  return JSON.stringify({ schemaVersion: CURRENT_KV_SCHEMA_VERSION, data });
}

function mockTinybirdFetch(status = 202) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function workerRequest(input: string, init?: RequestInit): Parameters<typeof worker.fetch>[0] {
  return new Request(input, init) as Parameters<typeof worker.fetch>[0];
}

function expectRow(rows: Record<string, unknown>[]): Record<string, unknown> {
  const row = rows[0];
  expect(row).toBeDefined();
  return row as Record<string, unknown>;
}

class TestExecutionContext {
  readonly props = {};
  waits: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.waits.push(promise);
  }

  passThroughOnException(): void {}
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

interface ExposurePayload {
  dedupKey: string;
  eventId: string;
  appId: string;
  environmentId: string;
  experimentId: string;
  runId: string;
  idType: string;
  targetingKeyHash: string;
  variantName: string;
  type: "exposure";
  sourceId: string;
  counterfactual: boolean;
  clientTimestamp: string;
  serverReceivedAt: string;
  ingestTs: string;
  sdkVersion: string;
}
