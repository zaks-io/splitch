import { describe, expect, it, vi } from "vitest";
import { planExperimentHandler } from "./experiment-plan-handler";

function depsWithEnvironment(found: boolean) {
  return {
    repo: {
      identity: {
        getEnvironment: vi.fn(async () => (found ? { id: "env_1" } : null)),
      },
    },
  } as never;
}

async function callPlan(body: Record<string, unknown>, requestId: string): Promise<Response> {
  return planExperimentHandler(depsWithEnvironment(true), {
    input: {
      params: { appId: "app_1", environmentId: "env_1" },
      body,
    },
    requestId,
    principal: null,
  } as never);
}

describe("planExperimentHandler", () => {
  it("returns a Start-ready targetN for a valid continuous plan", async () => {
    const response = await callPlan(
      {
        metricKind: "continuous",
        baselineMean: 10,
        baselineVariance: 25,
        armCount: 2,
        mdeAbsolute: 0.5,
        expectedDailyEligibleEntities: 2_000,
      },
      "req_1",
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { targetN: number; baselineSource: string };
    expect(body.targetN).toBeGreaterThan(0);
    expect(body.baselineSource).toBe("caller");
  });

  it("names missing continuous baselines in VALIDATION_ERROR", async () => {
    const response = await callPlan(
      {
        metricKind: "continuous",
        armCount: 2,
        mdeAbsolute: 0.5,
        expectedDailyEligibleEntities: 2_000,
      },
      "req_2",
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      code: string;
      details: { issues: Array<{ path: string[] }> };
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details.issues.map((issue) => issue.path.join("."))).toEqual([
      "body.baselineMean",
      "body.baselineVariance",
    ]);
  });

  it("names mdeAbsolute when relative MDE is used on a zero baseline", async () => {
    const response = await callPlan(
      {
        metricKind: "continuous",
        baselineMean: 0,
        baselineVariance: 1,
        armCount: 2,
        mdeRelative: 0.1,
        expectedDailyEligibleEntities: 1_000,
      },
      "req_3",
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      code: string;
      details: { issues: Array<{ path: string[]; message: string }> };
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details.issues).toEqual([
      {
        path: ["body", "mdeAbsolute"],
        message: "mdeRelative requires a non-zero baseline; provide mdeAbsolute instead.",
      },
    ]);
  });
});

describe("planExperimentHandler representability", () => {
  it("returns structured 400 when derived arm counts exceed safe integers", async () => {
    const response = await callPlan(
      {
        metricKind: "continuous",
        baselineMean: 0,
        baselineVariance: 1,
        armCount: 2,
        trafficSplit: [1e-16, 1],
        fixedSampleSizePerArm: 100,
        expectedDailyEligibleEntities: 1_000,
      },
      "req_4",
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      code: string;
      details: { issues: Array<{ path: string[]; message: string }> };
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details.issues).toEqual([
      {
        path: ["body", "fixedSampleSizePerArm"],
        message: expect.stringContaining("representable maximum"),
      },
    ]);
  });

  it("returns structured 400 when expectedDurationDays is not representable", async () => {
    const response = await callPlan(
      {
        metricKind: "continuous",
        baselineMean: 1,
        baselineVariance: 1,
        armCount: 2,
        mdeAbsolute: 0.1,
        expectedDailyEligibleEntities: 1e-20,
      },
      "req_5",
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      code: string;
      details: { issues: Array<{ path: string[]; message: string }> };
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details.issues.some((issue) => issue.path.includes("expectedDurationDays"))).toBe(
      true,
    );
  });

  it("returns structured 400 when mdeRelative overflows", async () => {
    const response = await callPlan(
      {
        metricKind: "continuous",
        baselineMean: 1e-320,
        baselineVariance: 1,
        armCount: 2,
        mdeAbsolute: 0.1,
        expectedDailyEligibleEntities: 1_000,
      },
      "req_6",
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      code: string;
      details: { issues: Array<{ path: string[]; message: string }> };
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details.issues).toEqual([
      {
        path: ["body", "mdeRelative"],
        message: expect.stringContaining("finite and positive"),
      },
    ]);
  });

  it("returns structured 400 when alpha is below the supported floor", async () => {
    const response = await callPlan(
      {
        metricKind: "continuous",
        baselineMean: 1,
        baselineVariance: 1,
        armCount: 2,
        mdeAbsolute: 0.1,
        alpha: 1e-20,
        expectedDailyEligibleEntities: 1_000,
      },
      "req_7",
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      code: string;
      details: { issues: Array<{ path: string[]; message: string }> };
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details.issues).toEqual([
      {
        path: ["body", "alpha"],
        message: expect.stringContaining("1e-10"),
      },
    ]);
  });
});
