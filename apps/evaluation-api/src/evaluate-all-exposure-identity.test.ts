import { type EvaluateAllResponse, experimentConfigKey, runConfigKey } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { experimentConfigKV, runConfigKV } from "./provider/fixtures";
import {
  APP_ID,
  CLIENT_KEY,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  evaluateAllRouteInit,
  FLAG_KEY,
  makeSdkRouteHarness,
} from "./sdk-route-test-fixtures";

const PATH = "/api/sdk/evaluate-all";

function ticketRunId(ticket: string): string {
  const encoded = ticket.split(".")[0];
  if (encoded === undefined) throw new Error("test expected an encoded Exposure Ticket payload");
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const payload = JSON.parse(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4))) as Record<
    string,
    unknown
  >;
  if (typeof payload.run_id !== "string") throw new Error("test expected a ticket run_id");
  return payload.run_id;
}

describe("POST /api/sdk/evaluate-all: Exposure identity transitions", () => {
  it("replaces a same-Variant ticket when the Experiment Run rolls over before first read", async () => {
    const harness = await makeSdkRouteHarness({
      liveRun: true,
      runOverrides: { allocation: { control: 0, treatment: 100 } },
    });
    const first = await harness.app.request(PATH, evaluateAllRouteInit(CLIENT_KEY));
    const firstBody = (await first.json()) as EvaluateAllResponse;
    const firstEntry = firstBody.evaluations[FLAG_KEY];
    const firstEtag = first.headers.get("etag");

    harness.configKv
      .put(
        experimentConfigKey(APP_ID, ENVIRONMENT_ID, EXPERIMENT_ID),
        experimentConfigKV({ liveRunId: "run-B" }),
      )
      .put(
        runConfigKey(APP_ID, ENVIRONMENT_ID, "run-B"),
        runConfigKV({ id: "run-B", allocation: { control: 0, treatment: 100 } }),
      );

    const second = await harness.app.request(
      PATH,
      evaluateAllRouteInit(CLIENT_KEY, {
        "if-none-match": firstEtag ?? "",
        "idempotency-key": "evaluate-all-run-B",
      }),
    );
    const secondBody = (await second.json()) as EvaluateAllResponse;
    const secondEntry = secondBody.evaluations[FLAG_KEY];

    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).not.toBe(firstEtag);
    expect(secondEntry).toMatchObject({
      variantName: "treatment",
      reason: "SPLIT",
      exposureIdentity: expect.any(String),
      exposureTicket: expect.any(String),
    });
    expect(secondEntry?.exposureIdentity).not.toBe(firstEntry?.exposureIdentity);
    expect(secondEntry?.exposureTicket).not.toBe(firstEntry?.exposureTicket);
    expect(ticketRunId(secondEntry?.exposureTicket ?? "")).toBe("run-B");
  });

  it("invalidates a fresh assignment when its same-Variant holdover materializes", async () => {
    const holdovers = new Map<string, { runId: string; variant: string }>();
    const harness = await makeSdkRouteHarness({
      liveRun: true,
      holdovers,
      runOverrides: { allocation: { control: 0, treatment: 100 } },
    });
    const first = await harness.app.request(PATH, evaluateAllRouteInit(CLIENT_KEY));
    const firstBody = (await first.json()) as EvaluateAllResponse;
    const firstEtag = first.headers.get("etag");
    expect(firstBody.evaluations[FLAG_KEY]).toMatchObject({
      variantName: "treatment",
      exposureIdentity: expect.any(String),
      exposureTicket: expect.any(String),
    });

    holdovers.set(EXPERIMENT_ID, { runId: "run-42", variant: "treatment" });
    const second = await harness.app.request(
      PATH,
      evaluateAllRouteInit(CLIENT_KEY, {
        "if-none-match": firstEtag ?? "",
        "idempotency-key": "evaluate-all-holdover",
      }),
    );
    const secondBody = (await second.json()) as EvaluateAllResponse;

    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).not.toBe(firstEtag);
    expect(secondBody.evaluations[FLAG_KEY]).toMatchObject({
      variantName: "treatment",
      reason: "SPLIT",
      exposureIdentity: null,
      exposureTicket: null,
    });
  });
});

describe("POST /api/sdk/evaluate-all: Exposure Ticket refresh", () => {
  it("keeps ETag stable when Exposure Ticket issued_at advances", async () => {
    const early = await makeSdkRouteHarness({
      liveRun: true,
      ticketNow: () => new Date("2026-07-03T00:00:00.000Z"),
    });
    const late = await makeSdkRouteHarness({
      liveRun: true,
      ticketNow: () => new Date("2026-07-03T01:00:00.000Z"),
    });

    const first = await early.app.request(PATH, evaluateAllRouteInit(CLIENT_KEY));
    const second = await late.app.request(PATH, evaluateAllRouteInit(CLIENT_KEY));
    const firstBody = (await first.json()) as EvaluateAllResponse;
    const secondBody = (await second.json()) as EvaluateAllResponse;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("etag")).toBe(second.headers.get("etag"));
    expect(firstBody.evaluations[FLAG_KEY]?.exposureIdentity).toBe(
      secondBody.evaluations[FLAG_KEY]?.exposureIdentity,
    );
    expect(firstBody.evaluations[FLAG_KEY]?.exposureTicket).not.toBe(
      secondBody.evaluations[FLAG_KEY]?.exposureTicket,
    );

    const revalidate = await late.app.request(
      PATH,
      evaluateAllRouteInit(CLIENT_KEY, {
        "if-none-match": first.headers.get("etag") ?? "",
      }),
    );
    expect(revalidate.status).toBe(304);
    expect(late.evaluationUsageSink.writes).toHaveLength(1);
  });

  it("refreshes an unread ticket before its validity window can expire", async () => {
    const early = await makeSdkRouteHarness({
      liveRun: true,
      ticketNow: () => new Date("2026-07-03T00:00:00.000Z"),
    });
    const late = await makeSdkRouteHarness({
      liveRun: true,
      ticketNow: () => new Date("2026-07-03T13:00:00.000Z"),
    });
    const first = await early.app.request(PATH, evaluateAllRouteInit(CLIENT_KEY));
    const firstBody = (await first.json()) as EvaluateAllResponse;
    const firstEtag = first.headers.get("etag");

    const revalidate = await late.app.request(
      PATH,
      evaluateAllRouteInit(CLIENT_KEY, {
        "if-none-match": firstEtag ?? "",
      }),
    );
    const secondBody = (await revalidate.json()) as EvaluateAllResponse;

    expect(revalidate.status).toBe(200);
    expect(revalidate.headers.get("etag")).not.toBe(firstEtag);
    expect(secondBody.evaluations[FLAG_KEY]?.exposureIdentity).toBe(
      firstBody.evaluations[FLAG_KEY]?.exposureIdentity,
    );
    expect(secondBody.evaluations[FLAG_KEY]?.exposureTicket).not.toBe(
      firstBody.evaluations[FLAG_KEY]?.exposureTicket,
    );
  });
});
