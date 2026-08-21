import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { remediationForServerError, warnStaleApprovalDiscard } from "./approval-stale-warn.js";
import { runCli } from "./cli.js";
import { EXIT_API, EXIT_OK } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

const actor = { userId: "user_1", authDoor: "id_jag" as const };
const approvalRequestId = "apr_01J00000000000000000000000";
const approvalReviewId = "rev_01J00000000000000000000000";
const targetVersion = `sha256:${"a".repeat(64)}`;

function staleApprovalRequest(details: Record<string, unknown>) {
  return {
    id: approvalRequestId,
    appId: "app_1",
    policyContexts: [
      {
        environmentId: "env_prod",
        changeTypes: ["targeting_rollout_value"],
        level: "confirm",
      },
    ],
    operation: "flag_config_update",
    target: {
      type: "flag_configuration",
      id: "fc_1",
      version: targetVersion,
    },
    diff: {
      current: { enabled: false },
      proposed: { enabled: true },
      entries: [
        {
          path: "/enabled",
          operation: "replace",
          current: false,
          proposed: true,
        },
      ],
    },
    status: "stale",
    proposer: actor,
    proposedAt: "2026-08-05T00:00:00.000Z",
    resolvedAt: "2026-08-05T00:01:00.000Z",
    applicationResult: null,
    latestReview: {
      id: approvalReviewId,
      approvalRequestId,
      action: "approve_and_apply",
      outcome: "stale",
      actor,
      reviewedAt: "2026-08-05T00:01:00.000Z",
      reason: null,
      idempotencyKey: "review-1",
      resultingTargetVersion: null,
      error: {
        code: "RUN_FROZEN",
        details,
      },
    },
  };
}

describe("warnStaleApprovalDiscard", () => {
  it("surfaces a recorded discard cause on stderr for a stale Approval Request", () => {
    const error = vi.fn();
    warnStaleApprovalDiscard(
      { error },
      staleApprovalRequest({
        frozenFields: ["flagConfig.targetingRules"],
        currentRunId: "run_live",
        recommendedAction: "END_RUNNING_RUN_FIRST",
      }),
    );
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toContain(approvalRequestId);
    expect(error.mock.calls[0]?.[0]).toContain("RUN_FROZEN");
    expect(error.mock.calls[0]?.[0]).toContain("flagConfig.targetingRules");
    expect(error.mock.calls[0]?.[0]).toContain("Re-propose");
  });

  it("carries fault when frozenFields are absent", () => {
    const error = vi.fn();
    warnStaleApprovalDiscard(
      { error },
      {
        ...staleApprovalRequest({}),
        latestReview: {
          id: approvalReviewId,
          approvalRequestId,
          action: "approve_and_apply",
          outcome: "stale",
          actor,
          reviewedAt: "2026-08-05T00:01:00.000Z",
          reason: null,
          idempotencyKey: "review-1",
          resultingTargetVersion: null,
          error: {
            code: "INTERNAL_SERVER_ERROR",
            details: { fault: "approval_changed_fields_undetermined" },
          },
        },
      },
    );
    expect(error.mock.calls[0]?.[0]).toContain("changed-field set could not be determined");
    expect(error.mock.calls[0]?.[0]).not.toContain("approval_changed_fields_undetermined");
  });

  it("explains an empty applyable change without printing the fault slug", () => {
    const error = vi.fn();
    warnStaleApprovalDiscard(
      { error },
      {
        ...staleApprovalRequest({}),
        latestReview: {
          id: approvalReviewId,
          approvalRequestId,
          action: "approve_and_apply",
          outcome: "stale",
          actor,
          reviewedAt: "2026-08-05T00:01:00.000Z",
          reason: null,
          idempotencyKey: "review-1",
          resultingTargetVersion: null,
          error: {
            code: "INTERNAL_SERVER_ERROR",
            details: { fault: "approval_empty_change" },
          },
        },
      },
    );
    expect(error.mock.calls[0]?.[0]).toContain("no Flag Configuration field to apply");
    expect(error.mock.calls[0]?.[0]).not.toContain("approval_empty_change");
  });

  it("stays quiet for a version-race stale with no recorded cause", () => {
    const error = vi.fn();
    warnStaleApprovalDiscard(
      { error },
      {
        id: "apr_01JQUIET000000000000000000",
        status: "stale",
        latestReview: { outcome: "stale", error: null },
      },
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("scans list payloads", () => {
    const error = vi.fn();
    warnStaleApprovalDiscard(
      { error },
      {
        items: [
          staleApprovalRequest({
            frozenFields: ["flagConfig.rollout"],
          }),
        ],
      },
    );
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toContain(approvalRequestId);
  });
});

describe("remediationForServerError", () => {
  it("names frozen fields on RUN_FROZEN", () => {
    expect(
      remediationForServerError(
        {
          code: "RUN_FROZEN",
          message: "running Run run_live owns this Flag Configuration field",
          details: {
            frozenFields: ["flagConfig.availableVariantNames"],
            currentRunId: "run_live",
            attemptedChange: "APPLY_APPROVED_FLAG_CONFIG:flag_1",
            recommendedAction: "END_RUNNING_RUN_FIRST",
          },
        },
        true,
      ),
    ).toContain("flagConfig.availableVariantNames");
  });

  it("does not invite a retry for undetermined changed fields", () => {
    const line = remediationForServerError(
      {
        code: "INTERNAL_SERVER_ERROR",
        message: "changed-field set could not be determined",
        details: { fault: "approval_changed_fields_undetermined" },
      },
      true,
    );
    expect(line).toContain("Re-propose");
    expect(line.toLowerCase()).not.toContain("retry the command");
  });

  it("does not invite a retry for an empty applyable change", () => {
    const line = remediationForServerError(
      {
        code: "INTERNAL_SERVER_ERROR",
        message: "Approval Request does not change any Flag Configuration field",
        details: { fault: "approval_empty_change" },
      },
      true,
    );
    expect(line).toContain("does not change any Flag Configuration field");
    expect(line.toLowerCase()).not.toContain("retry the command");
    expect(line).not.toContain("approval_empty_change");
  });
});

describe("executeApiOperation wires stale discard warnings", () => {
  it("prints the discard cause when approval-requests get returns stale", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const body = staleApprovalRequest({
      frozenFields: ["flagConfig.targetingRules"],
      currentRunId: "run_live",
      recommendedAction: "END_RUNNING_RUN_FIRST",
    });
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "GET" &&
          request.url.includes(`/approval-requests/${approvalRequestId}`),
        status: 200,
        body,
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      await runCli(["approval-requests", "get", approvalRequestId, "--json", "--app", "app_1"], {
        cwd: dir,
        credentialPath,
        fetch: transport.fetch,
      }),
    ).toBe(EXIT_OK);
    expect(log).toHaveBeenCalledWith(JSON.stringify(body));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("RUN_FROZEN"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("flagConfig.targetingRules"));
  });

  it("remediates RUN_FROZEN from approval-request-reviews create", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const serverError = {
      code: "RUN_FROZEN" as const,
      message: "running Run owns this field",
      details: {
        frozenFields: ["flagConfig.rollout"],
        currentRunId: "run_live",
        attemptedChange: "APPLY_APPROVED_FLAG_CONFIG:flag_1",
        recommendedAction: "END_RUNNING_RUN_FIRST" as const,
      },
    };
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "POST" &&
          request.url.includes("/approval-requests/") &&
          request.url.includes("/reviews"),
        status: 409,
        body: serverError,
      },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      await runCli(
        [
          "approval-request-reviews",
          "create",
          approvalRequestId,
          "--json",
          "--app",
          "app_1",
          "--body-json",
          JSON.stringify({ action: "approve_and_apply" }),
          "--idempotency-key",
          "idem_review_cli",
        ],
        { cwd: dir, credentialPath, fetch: transport.fetch },
      ),
    ).toBe(EXIT_API);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("RUN_FROZEN"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("flagConfig.rollout"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("End the running Run first"));
  });
});
