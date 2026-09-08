import type { ApprovalRequest } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { flagConfigurationApplication } from "./approval-flag-configuration-proposal";

const config = {
  flagId: "flag_1",
  environmentId: "env_1",
  version: 2,
  enabled: true,
  availableVariantNames: ["treatment"],
  targetingRules: [],
  rollout: null,
  experiment: null,
};

function winnerRequest(proposed: unknown): ApprovalRequest {
  return {
    id: "apr_01J00000000000000000000000",
    appId: "app_1",
    operation: "experiment_winner_promote",
    target: {
      type: "flag_configuration",
      id: "cfg_1",
      version: `sha256:${"a".repeat(64)}`,
    },
    policyContexts: [{ environmentId: "env_1", changeTypes: ["enabled_state"], level: "confirm" }],
    diff: {
      current: {},
      proposed: proposed as Record<string, unknown>,
      entries: [
        {
          path: "/flagConfiguration/enabled",
          operation: "replace",
          current: false,
          proposed: true,
        },
        {
          path: "/flagConfiguration/version",
          operation: "replace",
          current: 1,
          proposed: 2,
        },
      ],
    },
    status: "pending",
    proposedBy: { userId: "user_1", authDoor: "api_key" },
    proposedAt: "2026-09-08T12:00:00.000Z",
    resolvedAt: null,
    review: null,
  };
}

describe("winner Approval application projection", () => {
  it("unwraps the Flag Configuration and strips its JSON Pointer prefix", () => {
    expect(
      flagConfigurationApplication(
        winnerRequest({ decision: { conclusionId: "con_1" }, flagConfiguration: config }),
      ),
    ).toEqual({
      proposed: config,
      diffEntries: [
        { path: "/enabled", operation: "replace", current: false, proposed: true },
        { path: "/version", operation: "replace", current: 1, proposed: 2 },
      ],
    });
  });

  it("fails loud when the persisted winner projection lacks flagConfiguration", () => {
    expect(() =>
      flagConfigurationApplication(winnerRequest({ decision: { conclusionId: "con_1" } })),
    ).toThrow();
  });
});
