import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DeltaNudge, flagConfigKey } from "@splitch/contracts";
import { appScope, createRepository, envScope, type Repository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { Miniflare } from "miniflare";
import { createApp } from "./app.js";
import { makeControlPlaneAuthResolver } from "./auth-resolver.js";
import { makeConfigStore, type ConfigStoreWriter } from "./config-store.js";
import { type FixtureSigner, makeFixtureSigner } from "./fixture-signer.js";
import { makeJwksVerifier } from "./jwks-verify.js";
import { appAdminScope } from "./scope-binding.js";
import { makeSessionStore } from "./session-store.js";

const AUDIENCE = "https://cp.splitch.test";
export const NOW = "2026-07-01T20:00:00.000Z";
export const NOW_MS = Date.parse(NOW);
const USER_ID = "user_config_admin";

export const ids = {
  orgId: "org_config",
  appId: "app_config",
  environmentId: "env_prod",
  flagId: "flag_checkout",
  flagKey: "checkout-redesign",
  configId: "flag_config_checkout_prod",
  controlVariantId: "var_control",
  treatmentVariantId: "var_treatment",
  experimentId: "exp_checkout",
  liveRunId: "run_live",
  newerRunId: "run_newer_not_live",
};

export interface Harness {
  app: Hono;
  d1: D1Database;
  kv: KVNamespace;
  repo: Repository;
  signer: FixtureSigner;
  dispose: () => Promise<void>;
  nudges: DeltaNudge[];
  warnings: unknown[][];
  events: string[];
}

const allowLimiter: RateLimiter = () => ({ limited: false });

export async function makeHarness(): Promise<Harness> {
  const mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: ":memory:" },
    kvNamespaces: { SESSION_STORE: "sessions", CONFIG_STORE: "config" },
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  const kv = (await mf.getKVNamespace("CONFIG_STORE")) as unknown as KVNamespace;
  const sessions = (await mf.getKVNamespace("SESSION_STORE")) as unknown as KVNamespace;
  await applyMigrations(d1);
  await seedConfigGraph(d1);

  const repo = createRepository(d1);
  const signer = await makeFixtureSigner();
  const nudges: DeltaNudge[] = [];
  const warnings: unknown[][] = [];
  const events: string[] = [];
  const store = makeConfigStore({
    repo,
    kv: recordingKv(kv, repo, events),
    broadcaster: {
      broadcast(nudge) {
        events.push("broadcast");
        nudges.push(nudge);
      },
    },
    logger: { warn: (...args: unknown[]) => warnings.push(args) },
    now: () => new Date(NOW_MS),
  });

  const app = makeAuthedApp({ repo, signer, sessions }, store);
  return { app, d1, kv, repo, signer, nudges, warnings, events, dispose: () => mf.dispose() };
}

export function makeAuthedApp(
  h: Pick<Harness, "repo" | "signer"> & { sessions?: KVNamespace },
  store: ConfigStoreWriter,
): Hono {
  const verifier = makeJwksVerifier({
    fetchJwks: async () => h.signer.jwks,
    controlPlaneAudience: AUDIENCE,
  });
  return createApp({
    authResolver: makeControlPlaneAuthResolver({
      verifier,
      sessions: makeSessionStore(
        h.sessions ?? ({ get: async () => null } as unknown as KVNamespace),
      ),
      now: () => NOW_MS,
    }),
    rateLimiter: allowLimiter,
    repo: h.repo,
    configStore: { writerFor: () => store },
  });
}

export async function patchFlagConfig(
  h: Harness,
  body: Record<string, unknown>,
): Promise<Response> {
  return authedPatch(h.app, h.signer, body);
}

export async function authedPatch(app: Hono, signer: FixtureSigner, body: Record<string, unknown>) {
  const jwt = await token(signer);
  return app.request(`/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/config`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function token(signer: FixtureSigner, scopes = [appAdminScope(ids.appId)]): Promise<string> {
  return signer.sign({
    sub: USER_ID,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: Math.floor(NOW_MS / 1000),
    exp: Math.floor(NOW_MS / 1000) + 3600,
    scopes,
  });
}

export function faultingCommitRepo(repo: Repository): Repository {
  return {
    ...repo,
    flags: {
      ...repo.flags,
      async updateFlagConfig() {
        throw new Error("D1 commit failed");
      },
    },
  } as Repository;
}

export async function kvJson(kv: KVNamespace, key: string): Promise<unknown> {
  const raw = await kv.get(key, "text");
  if (!raw) throw new Error(`missing KV key ${key}`);
  return JSON.parse(raw);
}

function recordingKv(kv: KVNamespace, repo: Repository, events: string[]): KVNamespace {
  return new Proxy(kv, {
    get(target, prop) {
      if (prop !== "put") return Reflect.get(target, prop);
      return async (key: string, value: string, ...rest: unknown[]) => {
        if (key === flagConfigKey(ids.appId, ids.environmentId, ids.flagKey)) {
          const row = await repo.flags.getFlagConfig(
            envScope(ids.appId, ids.environmentId),
            ids.flagId,
          );
          events.push(`d1-before-kv:${String(row?.enabled)}`);
          events.push("kv:flag");
        }
        return target.put(key, value, ...(rest as []));
      };
    },
  }) as KVNamespace;
}

async function seedConfigGraph(d1: D1Database): Promise<void> {
  const repo = createRepository(d1);
  const aScope = appScope(ids.appId);
  const eScope = envScope(ids.appId, ids.environmentId);
  await repo.identity.createOrganization({
    id: ids.orgId,
    name: "Config Org",
    plan: "free",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.identity.createApp({
    id: ids.appId,
    organizationId: ids.orgId,
    name: "Config App",
    key: "config-app",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.identity.environments.insert(aScope, {
    id: ids.environmentId,
    appId: ids.appId,
    key: "production",
    name: "Production",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.flags.insert(aScope, {
    id: ids.flagId,
    appId: ids.appId,
    key: ids.flagKey,
    name: "Checkout redesign",
    defaultVariantId: ids.controlVariantId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.addVariant(aScope, ids.flagId, {
    id: ids.controlVariantId,
    name: "control",
    value: JSON.stringify("off"),
    createdAt: NOW,
  });
  await repo.flags.addVariant(aScope, ids.flagId, {
    id: ids.treatmentVariantId,
    name: "treatment",
    value: JSON.stringify("on"),
    createdAt: NOW,
  });
  await repo.flags.flagConfigs.insert(eScope, {
    id: ids.configId,
    appId: ids.appId,
    environmentId: ids.environmentId,
    flagId: ids.flagId,
    enabled: false,
    availableVariantNames: JSON.stringify(["control", "treatment"]),
    defaultVariantId: ids.controlVariantId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.experiments.experiments.insert(eScope, {
    id: ids.experimentId,
    appId: ids.appId,
    environmentId: ids.environmentId,
    key: "checkout-exp",
    flagId: ids.flagId,
    name: "Checkout experiment",
    status: "running",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    metrics: "[]",
    guardrailMetrics: "[]",
    dimensions: "[]",
    liveRunId: ids.liveRunId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await insertRun(repo, ids.liveRunId, 1, "2026-07-01T19:00:00.000Z");
  await insertRun(repo, ids.newerRunId, 2, "2026-07-01T19:30:00.000Z");
}

async function insertRun(repo: Repository, runId: string, runNumber: number, startedAt: string) {
  const variants = [
    { id: ids.controlVariantId, name: "control", value: "off" },
    { id: ids.treatmentVariantId, name: "treatment", value: "on" },
  ];
  await repo.experiments.runs.insert(envScope(ids.appId, ids.environmentId), {
    id: runId,
    appId: ids.appId,
    environmentId: ids.environmentId,
    experimentId: ids.experimentId,
    runNumber,
    targetingKeyField: "userId",
    targetingKeyType: "user",
    salt: `salt_${runId}`,
    allocation: JSON.stringify({ control: 50, treatment: 50 }),
    variantSet: JSON.stringify(variants),
    targetingRules: "[]",
    confidenceLevel: 0.95,
    decisionFamily: "[]",
    guardrailDecisions: "[]",
    configHash: `hash_${runId}`,
    startedAt,
    createdAt: startedAt,
  });
}

async function applyMigrations(d1: D1Database): Promise<void> {
  const migrationsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "packages",
    "db",
    "migrations",
  );
  const sql = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(migrationsDir, file), "utf8"))
    .join("\n");
  for (const statement of sql
    .split(/-->\s*statement-breakpoint/)
    .flatMap((chunk) => chunk.split(";"))
    .map((statement) => statement.trim())
    .filter(Boolean)) {
    await d1.exec(statement.replace(/\n/g, " "));
  }
}
