import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricEventClaimRetentionBackfillDurableObject } from "./metric-event-claim-retention-backfill";
import type { Env } from "./types";

describe("Metric Event claim retention backfill", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adopts one bounded Tinybird page and resumes from its last row", async () => {
    const requested: URL[] = [];
    const responses = [
      {
        data: [
          {
            dedup_key: "dedup-1",
            server_received_at: "2026-08-07 00:00:00.000",
          },
          {
            dedup_key: "dedup-2",
            server_received_at: "2026-08-08 00:00:00.000",
          },
        ],
      },
      { data: [] },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requested.push(new URL(String(input)));
        return Response.json(responses.shift());
      }),
    );
    const retained: Array<{ name: string; serverReceivedAt: string }> = [];
    const { object, runAlarm, alarmTime } = makeBackfill(retained);

    const first = await object.fetch(new Request("https://backfill.local/run", { method: "POST" }));

    expect(first.status).toBe(200);
    expect(retained).toEqual([
      { name: "dedup-1", serverReceivedAt: "2026-08-07T00:00:00.000Z" },
      { name: "dedup-2", serverReceivedAt: "2026-08-08T00:00:00.000Z" },
    ]);
    expect(alarmTime()).toBeTypeOf("number");
    expect(requested[0]?.searchParams.get("limit")).toBe("25");

    await runAlarm();

    expect(requested[1]?.searchParams.get("after_server_received_at")).toBe(
      "2026-08-08 00:00:00.000",
    );
    expect(requested[1]?.searchParams.get("after_dedup_key")).toBe("dedup-2");
    const status = await object.fetch(new Request("https://backfill.local/status"));
    await expect(status.json()).resolves.toMatchObject({ done: true });
  });
});

function makeBackfill(retained: Array<{ name: string; serverReceivedAt: string }>) {
  const storage = new Map<string, unknown>();
  let nextAlarm: number | null = null;
  const ctx = {
    storage: {
      async get<T>(key: string) {
        return storage.get(key) as T | undefined;
      },
      async put(key: string, value: unknown) {
        storage.set(key, structuredClone(value));
      },
      async setAlarm(time: number | Date) {
        nextAlarm = typeof time === "number" ? time : time.getTime();
      },
      async deleteAlarm() {
        nextAlarm = null;
      },
    },
  } as unknown as DurableObjectState;
  const env = {
    TINYBIRD_API_URL: "https://tinybird.test",
    TINYBIRD_READ_TOKEN: "read-token",
    METRIC_EVENT_OUTBOX: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
          retained.push({
            name,
            serverReceivedAt: String(JSON.parse(String(init?.body)).serverReceivedAt),
          });
          return Response.json({ retained: true });
        },
      }),
    },
  } as unknown as Env;
  const object = new MetricEventClaimRetentionBackfillDurableObject(ctx, env);
  return {
    object,
    alarmTime: () => nextAlarm,
    async runAlarm() {
      nextAlarm = null;
      await object.alarm();
    },
  };
}
