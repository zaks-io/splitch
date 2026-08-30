import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryEvaluationCommitOutbox,
  MemoryReplayWindow,
} from "./memory-replay-windows.test-fixture";
import { makeEnv, postEvaluationCommit } from "./test-fixtures";

afterEach(() => vi.restoreAllMocks());

describe("Evaluation commit ingest", () => {
  it("replays one durable usage and Exposure commit after the Exposure queue handoff fails", async () => {
    const env = makeEnv();
    vi.mocked(env.RAW_EVENTS_QUEUE.sendBatch).mockRejectedValueOnce(
      new Error("raw_events queue unavailable"),
    );
    const first = await postEvaluationCommit({ env });
    const retry = await postEvaluationCommit({ env });

    expect(first.response.status).toBe(503);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({ evaluation_count: 1, has_exposure: 1 });
    expect(retry.response.status).toBe(202);
    expect(retry.rows).toHaveLength(2);
    expect(retry.rows[0]?.dedup_key).toBe(first.rows[0]?.dedup_key);
    expect(retry.rows[1]?.dedup_key).toMatch(/^sha256:[a-f0-9]{64}$/);
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

  it("scopes commit idempotency to the admitted App identity generation", async () => {
    const outbox = new MemoryEvaluationCommitOutbox();
    const env = makeEnv(new MemoryReplayWindow(), outbox);
    let activeVersion = "app-v1";
    env.ENTITY_METRIC_PRIVACY = {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({
        fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(String(input)).pathname;
          if (path === "/register-app-evaluation") {
            const body = JSON.parse(String(init?.body)) as { identityVersion: string };
            return Response.json({ suppressed: body.identityVersion !== activeVersion });
          }
          if (["/register-app-entity", "/register-evaluation", "/suppressed"].includes(path)) {
            return Response.json({ suppressed: false });
          }
          return new Response("not found", { status: 404 });
        }),
      }),
    };

    const v1 = await postEvaluationCommit({ env, idempotencyKey: "same-caller-key" });
    expect(v1.response.status).toBe(202);
    expect(v1.rows).toHaveLength(2);
    const v1Identity = outbox.identities()[0];
    expect(v1Identity).toBeDefined();
    await outbox.privacyDeleteAll(v1Identity as string);

    activeVersion = "app-v2";
    const v2 = await postEvaluationCommit({
      env,
      identityVersion: "app-v2",
      idempotencyKey: "same-caller-key",
      payload: {
        eventId: "evt_v2",
        targetingKeyHash: "app-v2:targeting-key",
        entityFamilyHash: "app-v2:family",
      },
    });
    expect(v2.response.status).toBe(202);
    expect(v2.rows).toHaveLength(2);
    expect(v2.rows.map((row) => row.dedup_key)).not.toEqual(v1.rows.map((row) => row.dedup_key));
    expect(outbox.identities()).toHaveLength(2);

    const lateV1 = await postEvaluationCommit({ env, idempotencyKey: "same-caller-key" });
    expect(lateV1.response.status).toBe(202);
    expect(lateV1.rows).toHaveLength(0);
  });
});
