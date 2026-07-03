import { appScope, createRepository, envScope, type Repository } from "@splitch/db";
import { makeConfigStore, type ConfigStoreWriter } from "./config-store.js";
import {
  appToken,
  createDefaultApp,
  createFlag,
  type FlagDefinitionHarness,
  makeAppForRepo,
  makeFlagDefinitionHarness,
  NOW_ISO,
  request,
} from "./flag-definition-test-harness.js";

export type ExperimentRunHarness = {
  h: FlagDefinitionHarness;
  repo: Repository;
};

export type Fixture = Awaited<ReturnType<typeof experimentFixture>>;

export type StartResponse = {
  previousRunId: string | null;
  run: {
    id: string;
    allocation: Record<string, number>;
    targetingRules: Array<{ conditions: unknown[] }>;
    runNumber?: number;
  };
};

export async function makeExperimentRunHarness(): Promise<ExperimentRunHarness> {
  const h = await makeFlagDefinitionHarness();
  const repo = createRepository(h.bindings.d1);
  h.app = makeAppForRepo(h, repo, configStoreAccess(repo, h.bindings.kv));
  return { h, repo };
}

export async function experimentFixture(ctx: ExperimentRunHarness, environmentKey = "dev") {
  const createdApp = await createDefaultApp(ctx.h);
  const appId = createdApp.app.id;
  const environmentId = createdApp.environments.find((env) => env.key === environmentKey)?.id ?? "";
  const jwt = await appToken(ctx.h, appId);
  const flag = await createFlag(ctx.h, appId, jwt);
  await ctx.repo.flags.flagConfigs.insert(envScope(appId, environmentId), {
    id: `flag_config_${environmentKey}`,
    appId,
    environmentId,
    flagId: flag.id,
    enabled: true,
    availableVariantNames: JSON.stringify(["control", "treatment"]),
    defaultVariantId: flag.defaultVariantId,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  const metric = await ctx.repo.experiments.metrics.insert(appScope(appId), {
    id: `metric_${environmentKey}`,
    appId,
    key: `signup-${environmentKey}`,
    name: "Signup",
    kind: "binomial",
    eventName: "signed_up",
    createdAt: NOW_ISO,
  });
  const segment = await ctx.repo.flags.segments.insert(appScope(appId), {
    id: `segment_${environmentKey}`,
    appId,
    name: "Paid plan",
    conditions: JSON.stringify([{ attribute: "plan", operator: "eq", value: "paid" }]),
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  return { appId, environmentId, jwt, flag, metricId: metric.id, segmentId: segment.id };
}

export async function createExperimentDraft(
  ctx: ExperimentRunHarness,
  fx: Pick<Fixture, "appId" | "environmentId" | "jwt" | "flag" | "metricId">,
  body: Record<string, unknown>,
) {
  const res = await request(
    ctx.h,
    "POST",
    `/apps/${fx.appId}/envs/${fx.environmentId}/experiments`,
    fx.jwt,
    {
      appId: fx.appId,
      environmentId: fx.environmentId,
      name: String(body.key),
      key: body.key,
      flagId: fx.flag.id,
      targetingKey: "userId",
      targetingKeyType: "user",
      metrics: [{ metricId: fx.metricId }],
      ...body,
    },
  );
  if (res.status !== 200) {
    throw new Error(`create experiment failed ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as { id: string };
}

export async function patchExperiment(
  ctx: ExperimentRunHarness,
  fx: Fixture,
  experimentId: string,
  body: Record<string, unknown>,
) {
  return request(
    ctx.h,
    "PATCH",
    `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experimentId}`,
    fx.jwt,
    body,
  );
}

export async function startExperiment(
  ctx: ExperimentRunHarness,
  fx: Fixture,
  experimentId: string,
) {
  return request(
    ctx.h,
    "POST",
    `/apps/${fx.appId}/envs/${fx.environmentId}/experiments/${experimentId}/start`,
    fx.jwt,
  );
}

export async function endRun(ctx: ExperimentRunHarness, fx: Fixture, runId: string) {
  return request(
    ctx.h,
    "POST",
    `/apps/${fx.appId}/envs/${fx.environmentId}/runs/${runId}/end`,
    fx.jwt,
  );
}

export async function kvJson(ctx: ExperimentRunHarness, key: string): Promise<unknown> {
  const raw = await ctx.h.bindings.kv.get(key, "text");
  if (!raw) throw new Error(`missing KV key ${key}`);
  return JSON.parse(raw);
}

export async function insertSyntheticNewerRun(
  ctx: ExperimentRunHarness,
  fx: Fixture,
  experimentId: string,
): Promise<void> {
  await ctx.repo.experiments.runs.insert(envScope(fx.appId, fx.environmentId), {
    id: "run_newer_not_live",
    appId: fx.appId,
    environmentId: fx.environmentId,
    experimentId,
    runNumber: 99,
    status: "ended",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    salt: "synthetic-salt",
    allocation: JSON.stringify({ control: 100 }),
    variantSet: JSON.stringify([{ id: fx.flag.defaultVariantId, name: "control", value: false }]),
    targetingRules: "[]",
    confidenceLevel: 0.95,
    decisionFamily: "[]",
    guardrailDecisions: "[]",
    configHash: "sha256:synthetic",
    startedAt: NOW_ISO,
    endedAt: NOW_ISO,
    createdAt: NOW_ISO,
  });
}

function configStoreAccess(repo: Repository, kv: KVNamespace) {
  const writer = makeConfigStore({
    repo,
    kv,
    broadcaster: { broadcast() {} },
    now: () => new Date(Date.parse(NOW_ISO)),
  });
  return {
    writerFor(): ConfigStoreWriter {
      return writer;
    },
    liveUpdatesFor: () => ({
      connect: async () => new Response("test live updates unavailable", { status: 503 }),
    }),
  };
}
