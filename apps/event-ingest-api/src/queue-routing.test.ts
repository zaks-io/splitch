import { describe, expect, it, vi } from "vitest";
import worker from "./index";
import type { Env } from "./types";

describe("Event Ingest Queue routing", () => {
  it.each([
    "splitch-raw-events-local-dlq",
    "splitch-raw-evaluations-shared-preview-dlq",
    "splitch-metric-events-dlq",
    "splitch-metric-events-reconciliation-dlq",
    "splitch-unconfigured-queue",
  ])("rejects non-primary queue %s", async (queue) => {
    if (!worker.queue) throw new Error("queue handler is unavailable");

    await expect(
      worker.queue(emptyBatch(queue), {} as Env, {} as ExecutionContext),
    ).rejects.toThrow(`event-ingest-api received an unknown queue: ${queue}`);
  });
});

function emptyBatch(queue: string): MessageBatch<Record<string, unknown>> {
  return {
    queue,
    messages: [],
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}
