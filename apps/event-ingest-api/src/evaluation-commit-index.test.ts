import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryEvaluationCommitOutbox,
  MemoryReplayWindow,
} from "./memory-replay-windows.test-fixture";
import { makeEnv, postEvaluationCommit } from "./test-fixtures";

afterEach(() => vi.restoreAllMocks());

describe("Evaluation commit ingest", () => {
  it("replays one durable usage and Exposure commit after the Exposure append fails", async () => {
    const env = makeEnv();
    const first = await postEvaluationCommit({ statuses: [202, 500], env });
    const retry = await postEvaluationCommit({ env });

    expect(first.response.status).toBe(503);
    expect(first.rows).toHaveLength(2);
    expect(first.rows[0]).toMatchObject({ evaluation_count: 1, has_exposure: 1 });
    expect(retry.response.status).toBe(202);
    expect(retry.rows).toHaveLength(2);
    expect(retry.rows[0]?.dedup_key).toBe(first.rows[0]?.dedup_key);
    expect(retry.rows[1]?.dedup_key).toBe(first.rows[1]?.dedup_key);
  });

  it("acks a delivered commit without appending a second usage or Exposure row", async () => {
    const env = makeEnv();
    const first = await postEvaluationCommit({ env });
    const retry = await postEvaluationCommit({ env });

    expect(first.response.status).toBe(202);
    expect(first.rows).toHaveLength(2);
    expect(retry.response.status).toBe(202);
    expect(retry.rows).toHaveLength(0);
  });

  it("redacts a commit Exposure that races an existing Entity suppression cutoff", async () => {
    const outbox = new MemoryEvaluationCommitOutbox();
    const privacyDelete = vi.spyOn(outbox, "privacyDelete");
    const env = makeEnv(new MemoryReplayWindow(), outbox);
    env.ENTITY_METRIC_PRIVACY = {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({
        fetch: vi.fn(async (input: RequestInfo | URL) => {
          const path = new URL(String(input)).pathname;
          if (path === "/register-app-evaluation") {
            return Response.json({ suppressed: false });
          }
          if (["/register-app-entity", "/register-evaluation", "/suppressed"].includes(path)) {
            return Response.json({ suppressed: true });
          }
          return new Response("not found", { status: 404 });
        }),
      }),
    };

    const result = await postEvaluationCommit({ env });

    expect(result.response.status).toBe(202);
    expect(result.rows).toHaveLength(1);
    expect(privacyDelete).toHaveBeenCalledWith(expect.any(String), ["evt_retry_1"]);
  });

  it("purges and never retries a zero-Exposure raw Evaluation after App reset suppression", async () => {
    const outbox = new MemoryEvaluationCommitOutbox();
    const privacyDeleteAll = vi.spyOn(outbox, "privacyDeleteAll");
    const env = makeEnv(new MemoryReplayWindow(), outbox);
    env.ENTITY_METRIC_PRIVACY = {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({
        fetch: vi.fn(async (input: RequestInfo | URL) => {
          const path = new URL(String(input)).pathname;
          return path === "/register-app-evaluation"
            ? Response.json({ suppressed: true })
            : new Response("not found", { status: 404 });
        }),
      }),
    };

    const first = await postEvaluationCommit({ env, exposures: [] });
    const retry = await postEvaluationCommit({ env, exposures: [] });

    expect(first.response.status).toBe(503);
    expect(first.rows).toHaveLength(0);
    expect(retry.response.status).toBe(503);
    expect(retry.rows).toHaveLength(0);
    expect(privacyDeleteAll).toHaveBeenCalledTimes(2);
  });

  it("purges a commit sealed while App reset takes the serialized inventory boundary", async () => {
    const outbox = new MemoryEvaluationCommitOutbox();
    const privacyDeleteAll = vi.spyOn(outbox, "privacyDeleteAll");
    const env = makeEnv(new MemoryReplayWindow(), outbox);
    let appInventoryCalls = 0;
    env.ENTITY_METRIC_PRIVACY = {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({
        fetch: vi.fn(async (input: RequestInfo | URL) => {
          const path = new URL(String(input)).pathname;
          if (path === "/register-app-evaluation") {
            appInventoryCalls += 1;
            return Response.json({ suppressed: appInventoryCalls === 2 });
          }
          return new Response("not found", { status: 404 });
        }),
      }),
    };

    const result = await postEvaluationCommit({ env, exposures: [] });

    expect(result.response.status).toBe(503);
    expect(result.rows).toHaveLength(0);
    expect(privacyDeleteAll).toHaveBeenCalledTimes(1);
  });
});
