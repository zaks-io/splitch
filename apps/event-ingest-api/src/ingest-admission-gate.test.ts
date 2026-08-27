import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INGEST_ADMISSION_LAUNCH_PROFILE,
  INGEST_STREAMS,
  ingestAdmissionBudget,
  ingestAdmissionScopeName,
} from "./ingest-admission-config";
import {
  type AdmissionBucketState,
  type AdmissionCost,
  chargeIngestAdmission,
  evaluateAdmission,
  IngestAdmissionGateDurableObject,
  queuePayloadBytes,
} from "./ingest-admission-gate";
import type { Env } from "./types";

const TEST_BUDGET = {
  rowsPerSecond: 10,
  rowBurstCapacity: 2,
  bytesPerSecond: 100,
  byteBurstCapacity: 50,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Ingest Admission launch profile", () => {
  it("checks in a complete launch profile for every ingest stream", () => {
    for (const stream of INGEST_STREAMS) {
      expect(ingestAdmissionBudget(stream)).toEqual(INGEST_ADMISSION_LAUNCH_PROFILE[stream]);
    }
  });

  it("uses the checked-in metric_events row and byte budgets", () => {
    expect(ingestAdmissionBudget("metric_events")).toEqual(
      INGEST_ADMISSION_LAUNCH_PROFILE.metric_events,
    );
    expect(INGEST_ADMISSION_LAUNCH_PROFILE.metric_events).toEqual({
      rowsPerSecond: 100,
      rowBurstCapacity: 1_000,
      bytesPerSecond: 524_288,
      byteBurstCapacity: 5_242_880,
    });
  });

  it("scopes each object to App, Environment, and ingest stream", () => {
    expect(ingestAdmissionScopeName("app_shop", "env_prod", "metric_events")).toBe(
      JSON.stringify(["app_shop", "env_prod", "metric_events"]),
    );
    expect(ingestAdmissionScopeName("app_shop", "env_prod", "metric_events")).not.toBe(
      ingestAdmissionScopeName("app_other", "env_prod", "metric_events"),
    );
    expect(ingestAdmissionScopeName("app_shop", "env_prod", "metric_events")).not.toBe(
      ingestAdmissionScopeName("app_shop", "env_dev", "metric_events"),
    );
    expect(ingestAdmissionScopeName("app_shop", "env_prod", "metric_events")).not.toBe(
      ingestAdmissionScopeName("app_shop", "env_prod", "web_events"),
    );
  });
});

describe("evaluateAdmission", () => {
  it("admits a new row when both buckets have capacity", () => {
    const result = evaluateAdmission(null, 1_000, TEST_BUDGET, { rowCost: 1, byteCost: 10 });

    expect(result.decision).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(result.next).toEqual({ rowTokens: 1, byteTokens: 40, updatedAt: 1_000 });
  });

  it("rejects when the row budget is exhausted without changing bytes", () => {
    const state = tokens(0, 40, 1_000);
    const result = evaluateAdmission(state, 1_000, TEST_BUDGET, { rowCost: 1, byteCost: 10 });

    expect(result.decision.allowed).toBe(false);
    expect(result.decision.retryAfterMs).toBe(100);
    expect(result.next).toEqual(state);
  });

  it("rejects when the byte budget is exhausted without changing rows", () => {
    const state = tokens(2, 5, 1_000);
    const result = evaluateAdmission(state, 1_000, TEST_BUDGET, { rowCost: 1, byteCost: 10 });

    expect(result.decision.allowed).toBe(false);
    expect(result.decision.retryAfterMs).toBe(50);
    expect(result.next).toEqual(state);
  });

  it("allows a zero-cost exact replay without consuming tokens", () => {
    const state = tokens(0, 0, 1_000);
    const result = evaluateAdmission(state, 1_000, TEST_BUDGET, { rowCost: 0, byteCost: 0 });

    expect(result.decision).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(result.next.rowTokens).toBe(0);
    expect(result.next.byteTokens).toBe(0);
  });

  it("refills both buckets from the object's own elapsed time", () => {
    const result = evaluateAdmission(tokens(0, 0, 1_000), 1_200, TEST_BUDGET, {
      rowCost: 1,
      byteCost: 10,
    });

    expect(result.decision.allowed).toBe(true);
    expect(result.next).toEqual({ rowTokens: 1, byteTokens: 10, updatedAt: 1_200 });
  });
});

describe("IngestAdmissionGateDurableObject", () => {
  it("deducts both buckets atomically and leaves them unchanged on deny", async () => {
    const gate = makeGate();

    const first = await gate.charge({ rowCost: 1, byteCost: 40 });
    const denied = await gate.charge({ rowCost: 1, byteCost: 20 });

    expect(first.body).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(denied.body.allowed).toBe(false);
    expect(gate.stored()).toEqual({ row_tokens: 1, byte_tokens: 10, updated_at: 1_000_000 });
  });

  it("does not persist a zero-cost replay", async () => {
    const gate = makeGate();
    await gate.charge({ rowCost: 1, byteCost: 10 });

    const replay = await gate.charge({ rowCost: 0, byteCost: 0 });

    expect(replay.body).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(gate.stored()).toEqual({ row_tokens: 1, byte_tokens: 40, updated_at: 1_000_000 });
  });

  it("rejects an invalid admission request before touching storage", async () => {
    const gate = makeGate();

    const response = await gate.raw(
      new Request("https://ingest-admission.local/charge", {
        method: "POST",
        body: JSON.stringify({ rowCost: -1, byteCost: 1, budget: TEST_BUDGET }),
      }),
    );

    expect(response.status).toBe(400);
    expect(gate.stored()).toBeNull();
  });
});

describe("chargeIngestAdmission", () => {
  it("routes through the scoped object name and the metric_events launch budget", async () => {
    const seen: Array<{ name: string; body: Record<string, unknown> }> = [];
    const namespace = {
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
    };

    await chargeIngestAdmission(
      namespace,
      { appId: "app_shop", environmentId: "env_prod", ingestStream: "metric_events" },
      { rowCost: 1, byteCost: 32 },
    );

    expect(seen).toEqual([
      {
        name: JSON.stringify(["app_shop", "env_prod", "metric_events"]),
        body: {
          rowCost: 1,
          byteCost: 32,
          budget: INGEST_ADMISSION_LAUNCH_PROFILE.metric_events,
        },
      },
    ]);
  });

  it("fails closed when the binding is missing", async () => {
    await expect(
      chargeIngestAdmission(
        undefined,
        { appId: "app_shop", environmentId: "env_prod", ingestStream: "metric_events" },
        { rowCost: 1, byteCost: 8 },
      ),
    ).rejects.toThrow("INGEST_ADMISSION_GATE binding is unavailable");
  });

  it("counts serialized queue-payload bytes", () => {
    expect(queuePayloadBytes({ event_name: "signed_up" })).toBe(
      new TextEncoder().encode(JSON.stringify({ event_name: "signed_up" })).byteLength,
    );
  });
});

function tokens(rowTokens: number, byteTokens: number, updatedAt: number): AdmissionBucketState {
  return { rowTokens, byteTokens, updatedAt };
}

function makeGate() {
  const sql = new MemoryAdmissionSql();
  const now = 1_000_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  const object = new IngestAdmissionGateDurableObject(
    {
      storage: {
        sql,
        transactionSync<T>(fn: () => T) {
          return fn();
        },
      },
    } as unknown as DurableObjectState,
    {} as Env,
  );
  return {
    stored() {
      return sql.row;
    },
    raw(request: Request) {
      return object.fetch(request);
    },
    async charge(cost: AdmissionCost) {
      const response = await object.fetch(
        new Request("https://ingest-admission.local/charge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...cost, budget: TEST_BUDGET }),
        }),
      );
      return {
        status: response.status,
        body: (await response.json()) as { allowed: boolean; retryAfterMs: number },
      };
    },
  };
}

class MemoryAdmissionSql {
  row: { row_tokens: number; byte_tokens: number; updated_at: number } | null = null;

  exec(query: string, ...bindings: Array<string | number | null>) {
    const normalized = query.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("CREATE TABLE")) return { toArray: () => [] };
    if (normalized.startsWith("SELECT")) {
      return { toArray: () => (this.row === null ? [] : [this.row]) };
    }
    if (normalized.startsWith("INSERT")) {
      this.row = {
        row_tokens: Number(bindings[0]),
        byte_tokens: Number(bindings[1]),
        updated_at: Number(bindings[2]),
      };
      return { toArray: () => [] };
    }
    throw new Error(`unsupported sql: ${query}`);
  }
}
