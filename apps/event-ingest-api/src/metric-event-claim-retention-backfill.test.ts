import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetricEventClaimRetentionBackfillDurableObject } from "./metric-event-claim-retention-backfill";
import type { Env } from "./types";

const NOW = Date.parse("2026-09-01T00:00:00.000Z");

describe("Metric Event claim retention backfill paging", () => {
  useFixedClock();

  it("adopts one bounded Tinybird page and resumes from its last row", async () => {
    const requested = stubTinybird([
      page(["dedup-1", "2026-08-07 00:00:00.000"], ["dedup-2", "2026-08-08 00:00:00.000"]),
      page(),
    ]);
    const retained: Array<{ name: string; serverReceivedAt: string }> = [];
    const { object, runAlarm, alarmTime } = makeBackfill({ retained });

    const first = await run(object);

    expect(first.status).toBe(200);
    expect(retained).toEqual([
      { name: "dedup-1", serverReceivedAt: "2026-08-07T00:00:00.000Z" },
      { name: "dedup-2", serverReceivedAt: "2026-08-08T00:00:00.000Z" },
    ]);
    expect(alarmTime()).toBe(NOW + 1_000);
    expect(requested[0]?.searchParams.get("limit")).toBe("25");

    await runAlarm();

    expect(requested[1]?.searchParams.get("after_server_received_at")).toBe(
      "2026-08-08 00:00:00.000",
    );
    expect(requested[1]?.searchParams.get("after_dedup_key")).toBe("dedup-2");
    expect(alarmTime()).toBeNull();
    await expect(status(object)).resolves.toMatchObject({ done: true, failedAttempts: 0 });
  });

  it("halts on an in-retention missing claim and resumes once it ages out", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const requested = stubTinybird([
      page(
        ["dedup-expired", "2026-05-01 00:00:00.000"],
        ["dedup-adopted", "2026-08-06 00:00:00.000"],
        ["dedup-missing", "2026-08-07 00:00:00.000"],
        ["dedup-later", "2026-08-08 00:00:00.000"],
      ),
      page(
        ["dedup-missing", "2026-08-07 00:00:00.000"],
        ["dedup-later", "2026-08-08 00:00:00.000"],
      ),
    ]);
    const retained: Array<{ name: string; serverReceivedAt: string }> = [];
    const { object, runAlarm, alarmTime } = makeBackfill({
      retained,
      outboxStatus: (name) => (name === "dedup-adopted" || name === "dedup-later" ? 200 : 404),
    });

    const halted = await run(object);

    expect(halted.status).toBe(503);
    await expect(halted.json()).resolves.toMatchObject({
      afterDedupKey: "dedup-adopted",
      failedAttempts: 0,
      halted: { reason: "missing-claim", serverReceivedAt: "2026-08-07T00:00:00.000Z" },
    });
    expect(retained.map(({ name }) => name)).toEqual(["dedup-adopted"]);
    expect(alarmTime()).toBeNull();
    expect(errors).toHaveBeenCalledWith(
      "event-ingest-api Metric Event claim retention backfill halted",
      { reason: "missing-claim", serverReceivedAt: "2026-08-07T00:00:00.000Z" },
    );
    await runAlarm();
    expect(requested).toHaveLength(1);

    vi.setSystemTime(Date.parse("2026-11-06T00:00:00.000Z"));
    const daily = await run(object);

    expect(daily.status).toBe(200);
    expect(requested[1]?.searchParams.get("after_dedup_key")).toBe("dedup-adopted");
    const resumed = (await daily.json()) as { halted?: unknown };
    expect(resumed).toMatchObject({ afterDedupKey: "dedup-later", failedAttempts: 0 });
    expect(resumed.halted).toBeUndefined();
    expect(retained.map(({ name }) => name)).toEqual(["dedup-adopted", "dedup-later"]);
  });
});

describe("Metric Event claim retention backfill failures", () => {
  useFixedClock();

  it("backs off a failing page, halts at the retry bound, and resumes on the daily run", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const requested = stubTinybird([
      ...Array.from({ length: 7 }, () => new Response("unavailable", { status: 500 })),
      page(["dedup-1", "2026-08-07 00:00:00.000"]),
    ]);
    const { object, runAlarm, alarmTime } = makeBackfill();

    const first = await run(object);

    expect(first.status).toBe(503);
    await expect(first.json()).resolves.toMatchObject({ done: false, failedAttempts: 1 });
    const firstDelay = (alarmTime() ?? 0) - NOW;
    expect(firstDelay).toBeGreaterThanOrEqual(5_000);
    expect(errors).toHaveBeenCalledWith(
      "event-ingest-api Metric Event claim retention backfill failed",
      { failedAttempts: 1, failure: "Metric Event retention backfill returned HTTP 500" },
    );

    await runAlarm();
    expect((alarmTime() ?? 0) - NOW).toBeGreaterThan(firstDelay);
    for (let attempt = 3; attempt <= 7; attempt += 1) await runAlarm();

    await expect(status(object)).resolves.toMatchObject({
      failedAttempts: 7,
      halted: { reason: "retries-exhausted" },
    });
    expect(alarmTime()).toBeNull();
    expect(errors).toHaveBeenCalledWith(
      "event-ingest-api Metric Event claim retention backfill halted",
      expect.objectContaining({ reason: "retries-exhausted", failedAttempts: 7 }),
    );
    await runAlarm();
    expect(requested).toHaveLength(7);

    const daily = await run(object);

    expect(daily.status).toBe(200);
    const resumed = (await daily.json()) as { halted?: unknown };
    expect(resumed).toMatchObject({ afterDedupKey: "dedup-1", failedAttempts: 0 });
    expect(resumed.halted).toBeUndefined();
    expect(alarmTime()).toBe(NOW + 1_000);
  });

  it("counts attempts interrupted mid-page toward the retry bound", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hung = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", hung);
    const backfill = makeBackfill();
    let object = backfill.object;

    for (let attempt = 1; attempt <= 7; attempt += 1) {
      void object.alarm();
      await vi.waitFor(() => expect(hung).toHaveBeenCalledTimes(attempt));
      object = backfill.restart();
    }
    await object.alarm();

    expect(hung).toHaveBeenCalledTimes(7);
    await expect(status(object)).resolves.toMatchObject({
      failedAttempts: 7,
      halted: { reason: "retries-exhausted" },
    });
    expect(backfill.alarmTime()).toBeNull();
  });

  it("serializes /run and alarm so neither pages from a stale checkpoint", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let respond: (response: Response) => void = () => {};
    const reads = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    vi.stubGlobal("fetch", reads);
    const { object, alarmTime } = makeBackfill({ outboxStatus: () => 404 });

    const daily = run(object);
    await vi.waitFor(() => expect(reads).toHaveBeenCalledOnce());
    const alarm = object.alarm();
    respond(page(["dedup-missing", "2026-08-07 00:00:00.000"]));
    await Promise.all([daily, alarm]);

    expect(reads).toHaveBeenCalledOnce();
    await expect(status(object)).resolves.toMatchObject({ halted: { reason: "missing-claim" } });
    expect(alarmTime()).toBeNull();
  });

  it("never logs response bodies or unexpected error messages", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    stubTinybird([
      new Response('{"data": [{"dedup_key": "secret-dedup-key"', { status: 200 }),
      page(["dedup-1", "2026-08-07 00:00:00.000"]),
    ]);
    const { object, runAlarm } = makeBackfill({
      outboxStatus: () => {
        throw new Error("secret-dependency-detail");
      },
    });

    await run(object);
    await runAlarm();

    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).not.toContain("secret-dedup-key");
    expect(logged).not.toContain("secret-dependency-detail");
    expect(errors).toHaveBeenCalledWith(
      "event-ingest-api Metric Event claim retention backfill failed",
      { failedAttempts: 1, failure: "Metric Event retention backfill returned malformed JSON" },
    );
    expect(errors).toHaveBeenCalledWith(
      "event-ingest-api Metric Event claim retention backfill failed",
      { failedAttempts: 2, failure: "unexpected Error" },
    );
  });
});

function useFixedClock(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}

function run(object: MetricEventClaimRetentionBackfillDurableObject): Promise<Response> {
  return object.fetch(new Request("https://backfill.local/run", { method: "POST" }));
}

type PageRow = readonly [dedupKey: string, serverReceivedAt: string];

function page(...rows: PageRow[]): Response {
  return Response.json({
    data: rows.map(([dedup_key, server_received_at]) => ({ dedup_key, server_received_at })),
  });
}

function stubTinybird(responses: Response[]): URL[] {
  const requested: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      requested.push(new URL(String(input)));
      const next = responses.shift();
      if (next === undefined) throw new Error("unexpected Tinybird read");
      return next;
    }),
  );
  return requested;
}

async function status(object: MetricEventClaimRetentionBackfillDurableObject) {
  const response = await object.fetch(new Request("https://backfill.local/status"));
  return response.json();
}

function makeBackfill({
  retained = [],
  outboxStatus = () => 200,
}: {
  retained?: Array<{ name: string; serverReceivedAt: string }>;
  outboxStatus?: (name: string) => number;
} = {}) {
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
          const responseStatus = outboxStatus(name);
          if (responseStatus === 404) return new Response("not found", { status: 404 });
          retained.push({
            name,
            serverReceivedAt: String(JSON.parse(String(init?.body)).serverReceivedAt),
          });
          return Response.json({ retained: true }, { status: responseStatus });
        },
      }),
    },
  } as unknown as Env;
  const object = new MetricEventClaimRetentionBackfillDurableObject(ctx, env);
  return {
    object,
    /** A fresh instance over the same storage, as after an eviction. */
    restart: () => new MetricEventClaimRetentionBackfillDurableObject(ctx, env),
    alarmTime: () => nextAlarm,
    async runAlarm() {
      nextAlarm = null;
      await object.alarm();
    },
  };
}
