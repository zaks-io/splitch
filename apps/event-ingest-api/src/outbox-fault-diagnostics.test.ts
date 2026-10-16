import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvaluationCommitOutboxDurableObject } from "./evaluation-commit-outbox";
import { durableState } from "./evaluation-commit-outbox.test-fixture";
import { makeOutbox, row } from "./metric-event-outbox.fixture";
import type { Env } from "./types";

const CANARY = "qxZ7s3crt";
let logs: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  logs = ["error", "warn", "info", "log"].map((method) =>
    vi.spyOn(console, method as "error").mockImplementation(() => {}),
  );
});
afterEach(() => vi.restoreAllMocks());

function parseFailure(): Error {
  try {
    JSON.parse(`${CANARY}!`);
  } catch (error) {
    expect((error as Error).message).toContain(CANARY);
    return new Error("Queue publication failed", { cause: error });
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

describe("Outbox fault diagnostics", () => {
  it("withholds native parse causes while retaining a Metric Event for publication retry", async () => {
    const outbox = makeOutbox(async () => {
      throw parseFailure();
    });
    await outbox.claim(row("entity-1"));
    await outbox.runAlarm();
    expect(outbox.send).toHaveBeenCalledOnce();
    expect(outbox.stored()).toMatchObject({ queued: false, publicationAttempts: 1 });
    expect(outbox.alarmTime()).toBeGreaterThan(Date.now());
    assertSafe("event-ingest-api Metric Event outbox publication failed");
  });

  it("withholds native parse causes while retaining an Evaluation commit for publication retry", async () => {
    const state = durableState();
    const send = vi.fn(async () => {
      throw parseFailure();
    });
    const object = new EvaluationCommitOutboxDurableObject(state.ctx, {
      RAW_EVALUATIONS_QUEUE: { send },
      RAW_EVENTS_QUEUE: { sendBatch: vi.fn() },
      SPLITCH_PLATFORM_TARGET: "local",
    } as unknown as Env);
    const identity = "a".repeat(64);
    for (const [path, body] of [
      [
        "commit",
        { identity, payload: { usage: { idempotencyKey: "evaluation-1" }, exposureRows: [] } },
      ],
      ["activate", { identity }],
    ] as const) {
      const response = await object.fetch(
        new Request(`https://outbox.test/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(200);
    }
    await object.alarm();
    expect(send).toHaveBeenCalledOnce();
    expect(state.stored()?.publicationAttempts).toBe(1);
    expect(state.alarmTime()).toBeGreaterThan(Date.now());
    assertSafe("event-ingest-api Evaluation commit outbox publication failed");
  });
});
