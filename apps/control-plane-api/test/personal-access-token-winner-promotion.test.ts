import {
  type ConcludeRunResponse,
  createResultToken,
  FlagConfigKVSchema,
  flagConfigKey,
  kvEnvelope,
  personalAccessTokenAuthority,
} from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRow } from "../src/experiment-conclusion-handler-test-fixtures";
import {
  configStoreAccess,
  createExperimentDraft,
  type ExperimentRunHarness,
  experimentFixture,
  makeExperimentRunHarness,
} from "../src/experiment-run-test-fixture";
import { NOW_ISO, OWNER, request } from "../src/flag-definition-test-harness";
import { analysisEnvelope, statsOutput } from "../src/panel-experiments-test-fixtures";
import { makeTestApp } from "../src/test-app-fixture";
import { makePoolBindings } from "./pool-bindings";

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makePoolBindings);
});
afterEach(async () => ctx.h.bindings.dispose());

async function seedWinnerRun() {
  const fx = await experimentFixture(ctx);
  const experiment = await createExperimentDraft(ctx, fx, {
    key: "pat-winner-promotion",
    allocation: { control: 50, treatment: 50 },
    salt: "pat-winner-promotion-salt",
  });
  const app = appScope(fx.appId);
  const scope = envScope(fx.appId, fx.environmentId);
  // A legacy Run keeps this authority test independent of Start's pre-registration gates.
  const run = await ctx.repo.experiments.runs.insert(scope, {
    ...runRow("running"),
    appId: fx.appId,
    environmentId: fx.environmentId,
    experimentId: experiment.id,
    controlVariantId: fx.flag.defaultVariantId,
    variantSet: JSON.stringify(fx.flag.variants),
    startedAt: new Date(Date.parse(NOW_ISO) - 86_400_000).toISOString(),
    createdAt: NOW_ISO,
    createdBy: OWNER,
  });
  expect(
    await ctx.repo.experiments.updateExperiment(
      scope,
      experiment.id,
      { status: "running", liveRunId: run.id, updatedAt: NOW_ISO },
      null,
    ),
  ).toMatchObject({ liveRunId: run.id });
  const target = await ctx.repo.flags.getFlagConfig(scope, fx.flag.id);
  if (!target) throw new Error("winner Promotion fixture has no target Configuration");
  const stats = statsOutput();
  const resultToken = await createResultToken({
    appId: fx.appId,
    environmentId: fx.environmentId,
    experimentId: experiment.id,
    runId: run.id,
    runConfigHash: run.configHash,
    analysisVersion: run.analysisVersion,
    stats,
  });
  return { fx, experiment, app, scope, run, target, stats, resultToken };
}

describe("PAT write permission on a stored winner Promotion Approval Request", () => {
  it("refuses member then lets admin apply a session proposal and publish the winner", async () => {
    const { fx, experiment, app, scope, run, target, stats, resultToken } = await seedWinnerRun();
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
      analysis: {
        fetch: async () =>
          Response.json(
            analysisEnvelope(run.id, stats, {
              data_watermark: NOW_ISO,
              result_token: resultToken,
            }),
          ),
      } as unknown as Fetcher,
      nowIso: () => NOW_ISO,
    });
    const proposalKey = "pat-winner-proposal";
    const proposed = await request(
      ctx.h,
      "POST",
      `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experiment.id}/runs/${run.id}/conclusions`,
      fx.jwt,
      {
        selectedVariant: "treatment",
        expectedResultToken: resultToken,
        dataWatermark: NOW_ISO,
        target: {
          environmentId: fx.environmentId,
          flagId: fx.flag.id,
          expectedConfigVersion: target.version,
          proposedConfig: {
            enabled: true,
            availableVariantNames: ["control", "treatment"],
            targetingRules: [],
            rollout: { percentage: 100 },
          },
        },
        idempotencyKey: proposalKey,
      },
      proposalKey,
    );
    expect(proposed.status, await proposed.clone().text()).toBe(200);
    const proposal = (await proposed.json()) as ConcludeRunResponse;
    const approvalId = proposal.approvalRequest.id;
    expect(await ctx.repo.approvals.getRequest(app, approvalId)).toMatchObject({
      operation: "experiment_winner_promote",
      proposedBy: OWNER,
      proposedVia: "device_flow",
      status: "pending",
    });
    expect(proposal.conclusion).toMatchObject({ runId: run.id, selectedVariant: "treatment" });
    expect(await ctx.repo.experiments.getRun(scope, run.id)).toMatchObject({ status: "ended" });
    expect(await ctx.repo.flags.getFlagConfig(scope, fx.flag.id)).toEqual(target);
    const configKey = flagConfigKey(fx.appId, fx.environmentId, fx.flag.key);
    const beforePublished = await ctx.h.bindings.kv.get(configKey, "text");
    expect(beforePublished).not.toBeNull();

    const usePat = (role: "member" | "admin") => {
      const authority = personalAccessTokenAuthority(
        {
          organizations: [],
          apps: [{ id: fx.appId, organizationId: "org_flag_definition_crud", role: "owner" }],
        },
        [{ target: `app:${fx.appId}`, role, permissions: ["write"] }],
      );
      principal = {
        ...principal,
        authDoor: "personal_access_token",
        liveMembership: true,
        scopes: authority.scopes,
        personalAccessToken: { id: "pat_winner_promotion", permissions: authority.permissions },
      };
    };
    const review = (idempotencyKey: string) =>
      request(ctx.h, "POST", `/apps/${fx.appId}/approval-requests/${approvalId}/reviews`, fx.jwt, {
        action: "approve_and_apply",
        idempotency_key: idempotencyKey,
      });

    usePat("member");
    const refused = await review("pat-winner-member-review");
    expect(refused.status, await refused.clone().text()).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(await ctx.repo.approvals.getRequest(app, approvalId)).toMatchObject({
      status: "pending",
    });
    expect(await ctx.repo.approvals.listReviews(app, approvalId)).toHaveLength(0);
    expect(await ctx.repo.flags.getFlagConfig(scope, fx.flag.id)).toEqual(target);
    expect(await ctx.h.bindings.kv.get(configKey, "text")).toBe(beforePublished);

    usePat("admin");
    const applied = await review("pat-winner-admin-review");
    expect(applied.status, await applied.clone().text()).toBe(200);
    expect(await applied.json()).toMatchObject({ id: approvalId, status: "applied" });
    expect(await ctx.repo.approvals.getRequest(app, approvalId)).toMatchObject({
      operation: "experiment_winner_promote",
      proposedVia: "device_flow",
      status: "applied",
      resultingResourceType: "flag_configuration",
      resultingResourceId: target.id,
    });
    expect(await ctx.repo.approvals.listReviews(app, approvalId)).toMatchObject([
      {
        action: "approve_and_apply",
        outcome: "applied",
        reviewedVia: "personal_access_token",
        reviewedBy: OWNER,
      },
    ]);
    const stored = await ctx.repo.flags.getFlagConfig(scope, fx.flag.id);
    expect(stored).toMatchObject({ version: target.version + 1, enabled: true });
    expect(JSON.parse(stored?.rollout ?? "null")).toMatchObject({ percentage: 100 });
    const published = await ctx.h.bindings.kv.get(configKey, "text");
    if (!published) throw new Error("winner Configuration was not published");
    expect(kvEnvelope(FlagConfigKVSchema).parse(JSON.parse(published)).data).toMatchObject({
      id: fx.flag.id,
      enabled: true,
      availableVariantNames: ["control", "treatment"],
      experimentId: null,
      rollout: { percentage: 100 },
    });
  });
});
