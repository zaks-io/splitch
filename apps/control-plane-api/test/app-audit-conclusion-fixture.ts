import { createResultToken } from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { expect } from "vitest";
import {
  configStoreAccess,
  createExperimentDraft,
  type ExperimentRunHarness,
  experimentFixture,
  startExperiment,
} from "../src/experiment-run-test-fixture";
import { NOW_ISO } from "../src/flag-definition-test-harness";
import { analysisEnvelope, statsOutput } from "../src/panel-experiments-test-fixtures";
import { makeTestApp } from "../src/test-app-fixture";
import { NOW_MS } from "../src/test-constants";
import { auditRequest, CANARIES } from "./app-audit-mutation-fixture";

/** Real routes/repository/config writer; only the external Analysis reply is supplied. */
export async function auditConclusionFixture(ctx: ExperimentRunHarness) {
  const fx = await experimentFixture(ctx);
  const draft = await createExperimentDraft(ctx, fx, {
    key: "audit-conclusion",
    allocation: { control: 50, treatment: 50 },
    salt: CANARIES.secret,
  });
  const started = await startExperiment(ctx, fx, draft.id);
  expect(started.status, await started.clone().text()).toBe(200);
  const {
    run: { id: runId },
  } = (await started.json()) as { run: { id: string } };
  const scope = envScope(fx.appId, fx.environmentId);
  const run = await ctx.repo.experiments.getRun(scope, runId);
  const config = await ctx.repo.flags.getFlagConfig(scope, fx.flag.id);
  if (!run || !config)
    throw new Error("Conclude fixture requires its committed Run and Configuration");
  const stats = statsOutput();
  const watermark = new Date(Date.parse(NOW_ISO) + 8 * 86_400_000).toISOString();
  const resultToken = await createResultToken({
    appId: fx.appId,
    environmentId: fx.environmentId,
    experimentId: draft.id,
    runId,
    runConfigHash: run.configHash,
    analysisVersion: run.analysisVersion,
    stats,
  });
  const app = makeTestApp({
    repo: ctx.repo,
    signer: ctx.h.signer,
    sessions: ctx.h.bindings.kv,
    now: () => NOW_MS,
    nowIso: () => watermark,
    configStore: configStoreAccess(ctx.repo, ctx.h.bindings.kv),
    analysis: {
      fetch: async () =>
        Response.json(
          analysisEnvelope(runId, stats, { result_token: resultToken, data_watermark: watermark }),
        ),
    } as unknown as Fetcher,
  });
  const path = `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${draft.id}/runs/${runId}/conclusions`;
  const body = {
    selectedVariant: "treatment",
    expectedResultToken: resultToken,
    dataWatermark: watermark,
    target: {
      environmentId: fx.environmentId,
      flagId: fx.flag.id,
      expectedConfigVersion: config.version,
      proposedConfig: {
        enabled: false,
        availableVariantNames: ["control", "treatment"],
        targetingRules: [],
        rollout: null,
      },
    },
    reason: CANARIES.reason,
    idempotencyKey: "conclude-audit",
  };
  const conclude = (override: Record<string, unknown> = {}) =>
    auditRequest({
      app,
      jwt: fx.jwt,
      path,
      requestId: "request_conclude-audit",
      idempotencyKey: String(override.idempotencyKey ?? body.idempotencyKey),
      body: { ...body, ...override },
    });
  return { fx, draft, run, app, path, body, conclude, scope };
}
