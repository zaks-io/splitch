import { beforeEach, describe, expect, it, vi } from "vitest";

const axiomIngest = vi.fn();
const axiomFlush = vi.fn().mockResolvedValue(undefined);

vi.mock("@axiomhq/js", () => ({
  Axiom: class {
    ingest = axiomIngest;
    flush = axiomFlush;
  },
}));

import { createScrubbedEmitter } from "./emitter.js";

describe("createScrubbedEmitter", () => {
  beforeEach(() => {
    axiomIngest.mockReset();
    axiomFlush.mockReset();
    axiomFlush.mockResolvedValue(undefined);
  });

  it("extends Axiom flush through scheduleBackgroundWork when configured", async () => {
    const scheduled: Promise<unknown>[] = [];
    const emitter = createScrubbedEmitter({
      surface: "test-worker",
      axiomToken: "xaat-test-token",
      axiomDataset: "splitch-logs",
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
    });

    emitter.log("info", "request", { requestId: "req-1" });

    expect(scheduled).toHaveLength(1);
    await scheduled[0];
    expect(axiomIngest).toHaveBeenCalled();
    expect(axiomFlush).toHaveBeenCalled();
  });

  it("invokes onSentryCaptureException after scrubbing extras", () => {
    const captured: Array<{ error: unknown; extra: Record<string, unknown> }> = [];
    const emitter = createScrubbedEmitter({
      surface: "cli",
      sentryDsn: "https://example@sentry.io/1",
      onSentryCaptureException: (error, extra) => {
        captured.push({ error, extra });
      },
    });

    emitter.captureException(new Error("boom"), {
      targeting: { email: "leak@example.com" },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.extra.targeting).toBe("[Redacted]");
  });
});
