import { afterEach, describe, expect, it, vi } from "vitest";
import { type AdmissionCharge, admissionBinding } from "./admission-test-fixture";
import {
  ingestAdmissionCost,
  ingestAdmissionDenial,
  rejectIngestAdmission,
} from "./ingest-admission";
import {
  INGEST_ADMISSION_LAUNCH_PROFILE,
  INGEST_STREAMS,
  type IngestStream,
  ingestAdmissionScopeName,
} from "./ingest-admission-config";
import { chargeIngestAdmission } from "./ingest-admission-gate";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const STREAM_MESSAGE: Record<IngestStream, string> = {
  raw_evaluations: "Evaluation usage ingest admission capacity exceeded",
  raw_events: "Exposure ingest admission capacity exceeded",
  metric_events: "Metric Event ingest admission capacity exceeded",
  web_events: "Web Event ingest admission capacity exceeded",
};

describe.each(INGEST_STREAMS)("%s admission", (stream) => {
  it("allows and charges queued serialized bytes and logical row counts", async () => {
    const charges: AdmissionCharge[] = [];
    const rows = [
      { event_name: stream, n: 1 },
      { event_name: stream, n: 2 },
    ];
    const denied = await rejectIngestAdmission(
      admissionBinding({ allowed: true, retryAfterMs: 0 }, charges).INGEST_ADMISSION_GATE,
      { appId: "app_shop", environmentId: "env_prod", ingestStream: stream },
      rows,
      STREAM_MESSAGE[stream],
    );

    expect(denied).toBeNull();
    expect(charges).toEqual([
      {
        scope: ingestAdmissionScopeName("app_shop", "env_prod", stream),
        ...ingestAdmissionCost(rows),
      },
    ]);
    expect(charges[0]?.byteCost).toBeGreaterThan(0);
  });

  it("rejects when the gate is exhausted before accepting", async () => {
    const charges: AdmissionCharge[] = [];
    const denied = await rejectIngestAdmission(
      admissionBinding({ allowed: false, retryAfterMs: 2500 }, charges).INGEST_ADMISSION_GATE,
      { appId: "app_shop", environmentId: "env_prod", ingestStream: stream },
      [{ event_name: stream }],
      STREAM_MESSAGE[stream],
    );

    expect(denied?.status).toBe(429);
    expect(denied?.headers.get("retry-after")).toBe("3");
    await expect(denied?.json()).resolves.toMatchObject({
      code: "RATE_LIMITED",
      message: STREAM_MESSAGE[stream],
      details: { retryAfterMs: 2500 },
    });
    expect(charges).toHaveLength(1);
  });

  it.each([false, "throw"] as const)("fails closed when the gate is %s", async (admission) => {
    const denied = await ingestAdmissionDenial(
      admissionBinding(admission, []).INGEST_ADMISSION_GATE,
      { appId: "app_shop", environmentId: "env_prod", ingestStream: stream },
      [{ event_name: stream }],
      STREAM_MESSAGE[stream],
    );

    expect(denied).toEqual({
      code: "RATE_LIMITED",
      message: "Ingest Admission Gate is unavailable",
      details: { retryAfterMs: 1_000 },
    });
  });

  it.each([
    { allowed: true, retryAfterMs: -1 },
    { allowed: true, retryAfterMs: 50 },
    { allowed: false, retryAfterMs: 0 },
  ] as const)("fails closed on malformed decision %j", async (admission) => {
    const charges: AdmissionCharge[] = [];
    const denied = await ingestAdmissionDenial(
      admissionBinding(admission, charges).INGEST_ADMISSION_GATE,
      { appId: "app_shop", environmentId: "env_prod", ingestStream: stream },
      [{ event_name: stream }],
      STREAM_MESSAGE[stream],
    );

    expect(denied).toEqual({
      code: "RATE_LIMITED",
      message: "Ingest Admission Gate is unavailable",
      details: { retryAfterMs: 1_000 },
    });
    expect(charges).toHaveLength(1);
  });

  it("routes the charge through the stream launch budget", async () => {
    const seen: Array<{ name: string; body: Record<string, unknown> }> = [];
    await chargeIngestAdmission(
      {
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get(id: DurableObjectId) {
          return {
            async fetch(_input: RequestInfo | URL, init?: RequestInit) {
              seen.push({ name: String(id), body: JSON.parse(String(init?.body)) });
              return Response.json({ allowed: true, retryAfterMs: 0 });
            },
          };
        },
      },
      { appId: "app_shop", environmentId: "env_prod", ingestStream: stream },
      { rowCost: 1, byteCost: 32 },
    );

    expect(seen).toEqual([
      {
        name: ingestAdmissionScopeName("app_shop", "env_prod", stream),
        body: {
          rowCost: 1,
          byteCost: 32,
          budget: INGEST_ADMISSION_LAUNCH_PROFILE[stream],
        },
      },
    ]);
  });
});
