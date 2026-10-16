import { inspect } from "node:util";
import { activationConfigKey } from "@splitch/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  METRIC_APP_ID,
  METRIC_ENVIRONMENT_ID,
  makeMetricEventFixture,
  metricEventBody,
  sendActivation,
} from "./metric-event.test-fixture";
import { fixedNow, makeEnv, postEvaluationAt, postExposure } from "./test-fixtures";

const CANARY = "qxZ7s3crt";
let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  logs = ["error", "warn", "info", "log"].map((method) =>
    vi.spyOn(console, method as "error").mockImplementation(() => {}),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function parseFailure() {
  try {
    JSON.parse(`${CANARY}!`);
  } catch (error) {
    expect((error as Error).message).toContain(CANARY);
    return new Error("dependency failed", { cause: error });
  }
  throw new Error("Invalid JSON unexpectedly parsed");
}

function assertSafe(event: string) {
  expect(logs[0]).toHaveBeenCalledWith(event, expect.anything());
  const logged = inspect(
    logs.map((log) => log.mock.calls),
    {
      showHidden: true,
      depth: null,
      maxStringLength: null,
      maxArrayLength: null,
    },
  );
  expect(logged).not.toContain(CANARY);
  expect(logged).toContain("[message withheld]");
}

describe("Ingest fault diagnostics", () => {
  it("withholds parse causes from Exposure queue handoff failures", async () => {
    const env = makeEnv();
    vi.mocked(env.RAW_EVENTS_QUEUE.send).mockRejectedValueOnce(parseFailure());
    const result = await postExposure({ env });
    expect(result.response.status).toBe(503);
    assertSafe("event-ingest-api Exposure queue handoff failed");
  });

  it("withholds parse causes from Evaluation usage queue handoff failures", async () => {
    const env = makeEnv();
    vi.mocked(env.RAW_EVALUATIONS_QUEUE.send).mockRejectedValueOnce(parseFailure());
    const result = await postEvaluationAt(fixedNow, {}, undefined, env);
    expect(result.response.status).toBe(503);
    assertSafe("event-ingest-api Evaluation queue handoff failed");
  });

  it("withholds native parse failures from Activation configuration", async () => {
    const fixture = await makeMetricEventFixture();
    const store = fixture.env.CONFIG_STORE;
    if (!store) throw new Error("fixture Config Store is missing");
    const storeGet = store.get;
    const key = activationConfigKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID);
    vi.spyOn(store, "get").mockImplementation(async (...args: unknown[]) => {
      if (args[0] === key) throw parseFailure();
      return Reflect.apply(storeGet, store, args);
    });
    const response = await sendActivation(fixture, metricEventBody());
    expect(response.status).toBe(503);
    expect(fixture.claims.size).toBe(0);
    assertSafe("event-ingest-api activation resolution failed");
  });
});
