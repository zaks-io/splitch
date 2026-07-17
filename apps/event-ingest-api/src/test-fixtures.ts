import { CURRENT_KV_SCHEMA_VERSION, experimentConfigKey, runConfigKey } from "@splitch/contracts";
import { vi } from "vitest";
import worker from "./index";

export const appId = "app_credential";
export const clientAppId = "app_from_client";
export const environmentId = "env_prod";
export const experimentId = "exp_checkout";
export const liveRunId = "run_live";
export const priorRunId = "run_prior";
export const fixedNow = "2026-07-01T12:34:56.789Z";
export const organizationId = "org_credential";

export async function postExposure(
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
  return captureResponse(ctx, fetch, response);
}

export async function postEvaluation(
  payload: Partial<{
    evaluationCount: number;
    isBatch: boolean;
    isCached: boolean;
    hasExposure: boolean;
  }> = {},
) {
  vi.spyOn(Date, "now").mockReturnValue(new Date(fixedNow).getTime());
  const fetch = mockTinybirdFetch();
  const ctx = new TestExecutionContext();
  const response = await worker.fetch(
    workerRequest("https://event-ingest.test/api/internal/evaluations", {
      method: "POST",
      headers: {
        authorization: "Bearer internal_ingest_secret",
        "content-type": "application/json",
        "x-splitch-app-id": appId,
        "x-splitch-environment-id": environmentId,
        "x-splitch-organization-id": organizationId,
      },
      body: JSON.stringify({
        evaluationCount: 1,
        isBatch: false,
        isCached: false,
        hasExposure: false,
        idempotencyKey: "eval-request-1",
        ...payload,
      }),
    }),
    makeEnv(),
    ctx,
  );
  return captureResponse(ctx, fetch, response);
}

export function makeEnv() {
  return {
    CONFIG_STORE: seededConfigStore() as unknown as KVNamespace,
    SPLITCH_EVENT_INGEST_TOKEN: "internal_ingest_secret",
    TINYBIRD_API_URL: "https://tinybird.test",
    TINYBIRD_INGEST_TOKEN: "tb_ingest_secret",
    TINYBIRD_RAW_EVALUATIONS_INGEST_TOKEN: "tb_raw_evaluations_ingest_secret",
  };
}

export function mockTinybirdFetch(status = 202) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

export function workerRequest(
  input: string,
  init?: RequestInit,
): Parameters<typeof worker.fetch>[0] {
  return new Request(input, init) as Parameters<typeof worker.fetch>[0];
}

export function expectRow(rows: Record<string, unknown>[]): Record<string, unknown> {
  const row = rows[0];
  if (row === undefined) throw new Error("expected Tinybird row");
  return row;
}

export class TestExecutionContext {
  readonly props = {};
  waits: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.waits.push(promise);
  }

  passThroughOnException(): void {}
}

function captureResponse(
  ctx: TestExecutionContext,
  fetch: ReturnType<typeof mockTinybirdFetch>,
  response: Response,
) {
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
    runId: liveRunId,
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
    runConfigKey(appId, environmentId, priorRunId),
    envelope(runConfig(priorRunId, "prior-salt", "2026-05-01T00:00:00.000Z")),
  );
  kv.set(
    runConfigKey(appId, environmentId, liveRunId),
    envelope(runConfig(liveRunId, "run-salt", "2026-07-01T00:00:00.000Z")),
  );
  return kv;
}

function runConfig(id: string, salt: string, startedAt: string) {
  return {
    id,
    experimentId,
    salt,
    allocation: { control: 50, treatment: 50 },
    variantSet: [
      { id: "var_control", name: "control", value: false },
      { id: "var_treatment", name: "treatment", value: true },
    ],
    targetingRules: [],
    configHash: `sha256:${salt}`,
    startedAt,
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
