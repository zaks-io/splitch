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

describe("planExperimentHandler", () => {
  it("returns a Start-ready targetN for a valid continuous plan", async () => {
    const response = await planExperimentHandler(depsWithEnvironment(true), {
      input: {
        params: { appId: "app_1", environmentId: "env_1" },
        body: {
          metricKind: "continuous",
          baselineMean: 10,
          baselineVariance: 25,
          armCount: 2,
          mdeAbsolute: 0.5,
          expectedDailyEligibleEntities: 2_000,
        },
      },
      requestId: "req_1",
      principal: null,
    } as never);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { targetN: number; baselineSource: string };
    expect(body.targetN).toBeGreaterThan(0);
    expect(body.baselineSource).toBe("caller");
  });

  it("names missing continuous baselines in VALIDATION_ERROR", async () => {
    const response = await planExperimentHandler(depsWithEnvironment(true), {
      input: {
        params: { appId: "app_1", environmentId: "env_1" },
        body: {
          metricKind: "continuous",
          armCount: 2,
          mdeAbsolute: 0.5,
          expectedDailyEligibleEntities: 2_000,
        },
      },
      requestId: "req_2",
      principal: null,
    } as never);

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
    const response = await planExperimentHandler(depsWithEnvironment(true), {
      input: {
        params: { appId: "app_1", environmentId: "env_1" },
        body: {
          metricKind: "continuous",
          baselineMean: 0,
          baselineVariance: 1,
          armCount: 2,
          mdeRelative: 0.1,
          expectedDailyEligibleEntities: 1_000,
        },
      },
      requestId: "req_3",
      principal: null,
    } as never);

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

  it("returns structured 400 when derived arm counts exceed safe integers", async () => {
    const response = await planExperimentHandler(depsWithEnvironment(true), {
      input: {
        params: { appId: "app_1", environmentId: "env_1" },
        body: {
          metricKind: "continuous",
          baselineMean: 0,
          baselineVariance: 1,
          armCount: 2,
          trafficSplit: [1e-16, 1],
          fixedSampleSizePerArm: 100,
          expectedDailyEligibleEntities: 1_000,
        },
      },
      requestId: "req_4",
      principal: null,
    } as never);

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
});
