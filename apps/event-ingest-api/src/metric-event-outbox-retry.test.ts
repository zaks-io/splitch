import { afterEach, describe, expect, it, vi } from "vitest";
import { makeOutbox, row } from "./metric-event-outbox.fixture";

afterEach(() => vi.restoreAllMocks());

describe("Metric Event outbox publication retry", () => {
  it("backs off without failing the accepted claim", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const outbox = makeOutbox().failNextSend();
    await outbox.claim(row("entity-7"));

    await outbox.runAlarm();

    expect(outbox.stored()?.queued).toBe(false);
    expect(outbox.stored()?.publicationAttempts).toBe(1);
    expect(outbox.alarmTime()).toBeGreaterThanOrEqual(Date.now() + 5_000);
    await outbox.runAlarm();
    expect(outbox.send).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, "now").mockReturnValue(outbox.alarmTime() ?? Date.now());
    await outbox.runAlarm();
    expect(outbox.stored()?.queued).toBe(true);
  });

  it("preserves delivery state written while a queue send is in flight and then fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let rejectSend!: (error: Error) => void;
    const sendPaused = new Promise<void>((_resolve, reject) => {
      rejectSend = reject;
    });
    const outbox = makeOutbox(async () => sendPaused);
    await outbox.claim(row("entity-7"));

    const publication = outbox.runAlarm();
    await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledOnce());
    await outbox.beginDelivery("attempt-1");
    rejectSend(new Error("queue unavailable"));
    await publication;

    expect(outbox.stored()?.delivery).toMatchObject({
      attemptId: "attempt-1",
      state: "attempting",
    });
    expect(outbox.stored()?.publishing).toBe(false);
  });
});
