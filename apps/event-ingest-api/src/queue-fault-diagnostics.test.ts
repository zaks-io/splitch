import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMetricEventQueue } from "./metric-event-queue";
import { makeQueueFixture } from "./metric-event-queue-test-fixture";
import { deliverRawEventMessages, rawEventMessage } from "./raw-event-queue-test-fixture";
import { ndjsonBatches, sendNdjsonBatch } from "./tinybird-microbatch";

vi.mock("./tinybird-microbatch", { spy: true });

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

function parseFailure(): Error {
  try {
    JSON.parse(`${CANARY}!`);
  } catch (error) {
    expect((error as Error).message).toContain(CANARY);
    return error as Error;
  }
  throw new Error("Invalid JSON unexpectedly parsed");
}

function assertSafe(event: string) {
  expect(logs[0]).toHaveBeenCalledWith(event, expect.any(Object));
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

function queued() {
  return {
    id: "metric-1",
    timestamp: new Date(),
    attempts: 2,
    body: {
      dedup_key: "sha256:event-1",
      event_id: "event-1",
      app_id: "app_1",
      environment_id: "env_1",
      event_definition_id: "ed_1",
      event_definition_version_id: "edv_1",
      id_type: "user",
      targeting_key_hash: "v1:target",
      entity_family_hash: "v1:family",
      server_received_at: new Date().toISOString(),
    },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}
function batch(message: ReturnType<typeof queued>) {
  return {
    queue: "splitch-metric-events",
    messages: [message],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
    metadata: { metrics: { backlogCount: 1, backlogBytes: 100 } },
  };
}

describe("Queue fault diagnostics", () => {
  it("withholds parse causes from raw event privacy admission retries", async () => {
    const message = rawEventMessage("raw-1");
    const fetch = vi
      .fn()
      .mockRejectedValue(new Error("privacy unavailable", { cause: parseFailure() }));
    await deliverRawEventMessages("splitch-raw-events", [message], {
      ENTITY_METRIC_PRIVACY: {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: () => ({ fetch }),
      },
    });
    expect(fetch).toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    assertSafe("event-ingest-api raw event queue admission failed");
  });

  it("withholds a transport diagnostic from raw event delivery retries", async () => {
    vi.mocked(sendNdjsonBatch).mockResolvedValueOnce({
      kind: "retryable",
      reason: parseFailure().message,
    });
    const message = rawEventMessage("raw-1");
    await deliverRawEventMessages("splitch-raw-events", [message]);
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    assertSafe("event-ingest-api raw event delivery failed");
  });

  it("withholds native Response.json failures from individual Metric Event admission", async () => {
    const fixture = makeQueueFixture();
    const response = new Response(`${CANARY}!`);
    fixture.env.METRIC_EVENT_OUTBOX = {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () => ({ fetch: vi.fn(async () => response) }),
    };
    const message = queued();
    await handleMetricEventQueue(batch(message), fixture.env);
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    assertSafe("event-ingest-api Metric Event delivery failed");
  });

  it("withholds parse causes when Metric Event batch preparation fails", async () => {
    const fixture = makeQueueFixture();
    const message = queued();
    await fixture.seal(message.body);
    vi.mocked(ndjsonBatches).mockImplementationOnce(() => {
      throw new Error("batch preparation failed", { cause: parseFailure() });
    });
    await handleMetricEventQueue(batch(message), fixture.env);
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(fixture.deliveryState(message.body.dedup_key)).toBe("attempting");
    assertSafe("event-ingest-api Metric Event batch delivery failed");
    expect(logs[0]).toHaveBeenCalledWith(
      "event-ingest-api Metric Event delivery failed",
      expect.any(Object),
    );
  });
});
