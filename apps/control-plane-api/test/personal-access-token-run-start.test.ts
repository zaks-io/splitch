import { personalAccessTokenAuthority } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configStoreAccess,
  createExperimentDraft,
  type ExperimentRunHarness,
  experimentFixture,
  makeExperimentRunHarness,
  readEvaluationExperiment,
  startExperiment,
} from "../src/experiment-run-test-fixture";
import { NOW_ISO, OWNER, request } from "../src/flag-definition-test-harness";
import { makeTestApp } from "../src/test-app-fixture";
import { makePoolBindings } from "./pool-bindings";

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makePoolBindings);
});
afterEach(async () => ctx.h.bindings.dispose());

describe("PAT write permission on a stored Run Start Approval Request", () => {
  it("approves and applies a session proposal with write alone, committing the Run and its configuration", async () => {
    const fx = await experimentFixture(ctx, "prod");
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "pat-run-start",
      allocation: { control: 50, treatment: 50 },
      salt: "pat-run-start-salt",
    });
    let principal: Principal = {
      kind: "control-plane-token",
      id: OWNER,
      scopes: [`app:${fx.appId}:owner`],
      orgId: null,
      appId: fx.appId,
      environmentId: null,
      authDoor: "device_flow",
    };
    ctx.h.app = makeTestApp({
      repo: ctx.repo,
      authResolver: () => ({ ok: true, principal }),
      configStore: configStoreAccess(ctx.repo, ctx.h.bindings.kv),
      nowIso: () => NOW_ISO,
    });
    const preRegistration = {
      hypothesis: "Treatment raises signup by at least two percentage points",
      primaryMetricId: fx.metricId,
      metrics: [
        {
          metricId: fx.metricId,
          desirability: "higher_is_better",
          mdeAbsolute: 0.02,
          rope: { lower: -0.005, upper: 0.005, scale: "absolute" },
        },
      ],
      shipRule: {
        requiredMargin: 0.02,
        marginScale: "absolute",
        conflictResolution: "primary_wins",
      },
    };
    const proposed = await startExperiment(ctx, fx, experiment.id, { preRegistration });
    expect(proposed.status, await proposed.clone().text()).toBe(409);
    const proposal = (await proposed.json()) as {
      code: string;
      details: { approvalRequestId: string };
    };
    expect(proposal.code).toBe("APPROVAL_REVIEW_REQUIRED");
    const app = appScope(fx.appId);
    const scope = envScope(fx.appId, fx.environmentId);
    const approvalId = proposal.details.approvalRequestId;
    expect(await ctx.repo.approvals.getRequest(app, approvalId)).toMatchObject({
      operation: "experiments_start",
      proposedVia: "device_flow",
      status: "pending",
    });
    expect((await ctx.repo.experiments.getExperiment(scope, experiment.id))?.liveRunId).toBeNull();
    expect(await ctx.repo.approvals.listReviews(app, approvalId)).toHaveLength(0);

    const authority = personalAccessTokenAuthority(
      {
        organizations: [],
        apps: [{ id: fx.appId, organizationId: "org_flag_definition_crud", role: "owner" }],
      },
      [{ target: `app:${fx.appId}`, role: "admin", permissions: ["write"] }],
    );
    principal = {
      ...principal,
      authDoor: "personal_access_token",
      liveMembership: true,
      scopes: authority.scopes,
      personalAccessToken: { id: "pat_run_start", permissions: authority.permissions },
    };
    const applied = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/approval-requests/${approvalId}/reviews`,
      fx.jwt,
      {
        action: "approve_and_apply",
        idempotency_key: "pat-run-start-review",
      },
    );
    expect(applied.status, await applied.clone().text()).toBe(200);
    expect(await applied.json()).toMatchObject({ id: approvalId, status: "applied" });
    const stored = await ctx.repo.approvals.getRequest(app, approvalId);
    expect(stored).toMatchObject({ status: "applied", resultingResourceType: "experiment_run" });
    const runId = stored?.resultingResourceId;
    if (!runId) throw new Error("applied Run Start has no resulting Run");
    const run = await ctx.repo.experiments.getRun(scope, runId);
    expect(run).toMatchObject({ experimentId: experiment.id, status: "running", createdBy: OWNER });
    expect(JSON.parse(run?.allocation ?? "null")).toEqual({ control: 50, treatment: 50 });
    expect(JSON.parse(run?.preRegistration ?? "null")).toMatchObject({
      hypothesis: preRegistration.hypothesis,
      primary_metric_id: fx.metricId,
    });
    expect(await ctx.repo.approvals.listReviews(app, approvalId)).toMatchObject([
      {
        action: "approve_and_apply",
        outcome: "applied",
        reviewedVia: "personal_access_token",
        reviewedBy: OWNER,
      },
    ]);
    expect(await readEvaluationExperiment(ctx, fx, experiment.id)).toMatchObject({
      liveRunId: runId,
      liveRun: { experimentId: experiment.id },
    });
  });
});
