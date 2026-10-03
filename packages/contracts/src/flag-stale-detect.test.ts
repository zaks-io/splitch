import { describe, expect, it } from "vitest";
import {
  detectStaleReasons,
  daysBetween,
  uniformServingMode,
  type EnvironmentConfigState,
} from "./flag-stale-detect";

const NOW = "2026-07-02T12:00:00.000Z";

function env(overrides: Partial<EnvironmentConfigState> = {}): EnvironmentConfigState {
  return {
    environmentId: "env_test",
    enabled: true,
    targetingRuleCount: 0,
    rolloutPercentage: 100,
    hasRunningExperiment: false,
    updatedAt: "2026-05-01T00:00:00.000Z",
    lastRunLifecycleAt: null,
    ...overrides,
  };
}

describe("uniformServingMode", () => {
  it("accepts disabled, default-only, and full rollout without Targeting Rules", () => {
    expect(uniformServingMode(env({ enabled: false, rolloutPercentage: 50 }))).toBe("disabled");
    expect(uniformServingMode(env({ rolloutPercentage: null }))).toBe("default_only");
    expect(uniformServingMode(env({ rolloutPercentage: 0 }))).toBe("default_only");
    expect(uniformServingMode(env({ rolloutPercentage: 100 }))).toBe("full_rollout");
  });

  it("rejects Targeting Rules, partial rollout, and a running Experiment", () => {
    expect(uniformServingMode(env({ targetingRuleCount: 1 }))).toBeNull();
    expect(uniformServingMode(env({ rolloutPercentage: 50 }))).toBeNull();
    expect(uniformServingMode(env({ hasRunningExperiment: true }))).toBeNull();
  });
});

describe("detectStaleReasons", () => {
  it("flags a release Flag at 100% for 30+ days and not a 50/50 Flag", () => {
    const stale = detectStaleReasons({
      lifecycleClass: "release",
      expiresAt: "2026-12-01T00:00:00.000Z",
      flagUpdatedAt: "2026-06-01T00:00:00.000Z",
      lastChangeLogAt: "2026-06-01T00:00:00.000Z",
      configurations: [
        env({ environmentId: "env_dev", updatedAt: "2026-05-01T00:00:00.000Z" }),
        env({ environmentId: "env_prod", updatedAt: "2026-05-15T00:00:00.000Z" }),
      ],
      now: NOW,
    });
    expect(stale.servingEvidence).toBe("unverified");
    expect(stale.reasons.map((reason) => reason.kind)).toContain("uniform_serving");

    const split = detectStaleReasons({
      lifecycleClass: "release",
      expiresAt: "2026-12-01T00:00:00.000Z",
      flagUpdatedAt: "2026-06-01T00:00:00.000Z",
      lastChangeLogAt: "2026-06-01T00:00:00.000Z",
      configurations: [
        env({ environmentId: "env_dev", rolloutPercentage: 50 }),
        env({ environmentId: "env_prod", rolloutPercentage: 50 }),
      ],
      now: NOW,
    });
    expect(split.reasons.map((reason) => reason.kind)).not.toContain("uniform_serving");
  });

  it("counts the uniform window from End when a Run controlled the Flag", () => {
    const afterRecentEnd = detectStaleReasons({
      lifecycleClass: "release",
      expiresAt: "2026-12-01T00:00:00.000Z",
      flagUpdatedAt: "2026-05-01T00:00:00.000Z",
      lastChangeLogAt: "2026-06-20T00:00:00.000Z",
      configurations: [
        env({
          environmentId: "env_dev",
          updatedAt: "2026-05-01T00:00:00.000Z",
          lastRunLifecycleAt: "2026-06-20T00:00:00.000Z",
        }),
        env({ environmentId: "env_prod", updatedAt: "2026-05-01T00:00:00.000Z" }),
      ],
      now: NOW,
    });
    expect(afterRecentEnd.reasons.map((reason) => reason.kind)).not.toContain("uniform_serving");

    const afterAgedEnd = detectStaleReasons({
      lifecycleClass: "release",
      expiresAt: "2026-12-01T00:00:00.000Z",
      flagUpdatedAt: "2026-05-01T00:00:00.000Z",
      lastChangeLogAt: "2026-05-20T00:00:00.000Z",
      configurations: [
        env({
          environmentId: "env_dev",
          updatedAt: "2026-05-01T00:00:00.000Z",
          lastRunLifecycleAt: "2026-05-20T00:00:00.000Z",
        }),
        env({ environmentId: "env_prod", updatedAt: "2026-05-01T00:00:00.000Z" }),
      ],
      now: NOW,
    });
    const uniform = afterAgedEnd.reasons.find((reason) => reason.kind === "uniform_serving");
    expect(uniform).toMatchObject({
      kind: "uniform_serving",
      uniformSince: "2026-05-20T00:00:00.000Z",
    });
  });

  it("does not apply uniform-serving or unchanged to permanent classes", () => {
    const result = detectStaleReasons({
      lifecycleClass: "permission",
      expiresAt: null,
      flagUpdatedAt: "2024-01-01T00:00:00.000Z",
      lastChangeLogAt: "2024-01-01T00:00:00.000Z",
      configurations: [env({ environmentId: "env_dev" }), env({ environmentId: "env_prod" })],
      now: NOW,
    });
    expect(result.reasons).toEqual([]);
  });

  it("reports past_expiry and unchanged with typed evidence", () => {
    const result = detectStaleReasons({
      lifecycleClass: "experiment",
      expiresAt: "2026-06-01T00:00:00.000Z",
      flagUpdatedAt: "2026-01-01T00:00:00.000Z",
      lastChangeLogAt: null,
      configurations: [
        env({
          environmentId: "env_dev",
          enabled: false,
          updatedAt: "2026-06-20T00:00:00.000Z",
        }),
      ],
      now: NOW,
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "past_expiry", expiresAt: "2026-06-01T00:00:00.000Z" }),
        expect.objectContaining({
          kind: "unchanged",
          source: "flag_updated_at",
          lastChangedAt: "2026-01-01T00:00:00.000Z",
        }),
      ]),
    );
  });
});

describe("daysBetween", () => {
  it("measures whole days between ISO instants", () => {
    expect(daysBetween("2026-05-01T00:00:00.000Z", "2026-05-31T00:00:00.000Z")).toBe(30);
  });
});
