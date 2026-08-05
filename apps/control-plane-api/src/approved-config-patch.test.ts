import { describe, expect, it } from "vitest";
import { approvedConfigPatch } from "./config-store-approved-write";
import type { ApplyApprovedFlagConfigInput } from "./config-store-types";

/**
 * SPL-304 follow-up: an entries-based freeze that then writes every proposed
 * field is still a hole. These pins fail if `availableVariantNames` / `rollout`
 * leave the patch without a matching entry.
 */
describe("approvedConfigPatch", () => {
  const base = {
    appId: "app_1",
    environmentId: "env_1",
    flagId: "flag_1",
    proposed: {
      flagId: "flag_1",
      environmentId: "env_1",
      version: 1,
      enabled: true,
      availableVariantNames: ["control"],
      targetingRules: [],
      rollout: { percentage: 10, salt: "mint" },
      experiment: null,
    },
    approval: {
      requestId: "apr_01J00000000000000000000000",
      reviewId: "rev_01J00000000000000000000000",
      action: "approve_and_apply" as const,
      reviewedBy: "user_1",
      reviewedVia: "id_jag" as const,
      reviewedAt: "2026-08-05T00:00:00.000Z",
      reason: null,
      idempotencyKey: "idem",
      requestHash: `sha256:${"a".repeat(64)}`,
      resultingTargetVersion: `sha256:${"b".repeat(64)}`,
      resultingResourceType: "flag_configuration" as const,
      resultingResourceId: "fc_1",
      policyContexts: [],
    },
  } satisfies Omit<ApplyApprovedFlagConfigInput, "diffEntries">;

  it("writes only enabled for an enabled-only entry set", () => {
    expect(
      approvedConfigPatch({
        ...base,
        diffEntries: [{ path: "/enabled" }, { path: "/version" }],
      }),
    ).toEqual({
      updatedAt: base.approval.reviewedAt,
      enabled: true,
    });
  });

  it("includes rollout only when entries touch it", () => {
    expect(
      approvedConfigPatch({
        ...base,
        diffEntries: [{ path: "/rollout/percentage" }, { path: "/version" }],
      }),
    ).toMatchObject({
      rollout: expect.stringContaining('"percentage":10'),
    });
    expect(
      approvedConfigPatch({
        ...base,
        diffEntries: [{ path: "/enabled" }],
      }).rollout,
    ).toBeUndefined();
  });

  it("includes availableVariantNames only when entries touch it", () => {
    expect(
      approvedConfigPatch({
        ...base,
        diffEntries: [{ path: "/availableVariantNames" }],
      }).availableVariantNames,
    ).toBeDefined();
    expect(
      approvedConfigPatch({
        ...base,
        diffEntries: [{ path: "/enabled" }],
      }).availableVariantNames,
    ).toBeUndefined();
  });
});
