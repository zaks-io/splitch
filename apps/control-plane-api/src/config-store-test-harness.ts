import { type DeltaNudge, type EnvironmentPolicy, flagConfigKey } from "@splitch/contracts";
import { appScope, createRepository, envScope, type Repository } from "@splitch/db";
import { migrationStatements } from "@splitch/db/test-d1";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { Miniflare } from "miniflare";
import { createApp } from "./app";
import { makeControlPlaneAuthResolver } from "./auth-resolver";
import { type ConfigStoreWriter, makeConfigStore } from "./config-store";
import { ids, NOW, NOW_MS, seedConfigGraph } from "./config-store-fixture-data";
import { type FixtureSigner, makeFixtureSigner } from "./fixture-signer";
import { makeJwksVerifier } from "./jwks-verify";
import { appAdminScope } from "./scope-binding";
import { makeSessionStore } from "./session-store";
import { seedAppMember } from "./test-fixtures";

const AUDIENCE = "https://cp.splitch.test";
const USER_ID = "user_config_admin";

export { ids, NOW, NOW_MS };

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
  await seedAppMember(d1, { appId: ids.appId, userId: USER_ID, role: "owner" });

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
    configStore: {
      writerFor: () => store,
      liveUpdatesFor: () => ({
        connect: async () => new Response("test live updates unavailable", { status: 503 }),
      }),
    },
  });
}

export async function patchFlagConfig(
  h: Harness,
  body: Record<string, unknown>,
): Promise<Response> {
  return authedPatch(h.app, h.signer, body);
}

export async function replaceTargetingRules(
  h: Harness,
  body: Record<string, unknown>,
): Promise<Response> {
  const jwt = await token(h.signer);
  return h.app.request(
    `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/targeting-rules`,
    {
      method: "PUT",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export async function promoteFlagConfig(
  h: Harness,
  body: Record<string, unknown>,
): Promise<Response> {
  const jwt = await token(h.signer);
  return h.app.request(`/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/promote`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function setProdPolicy(h: Harness, policy: EnvironmentPolicy): Promise<void> {
  await h.repo.identity.updateEnvironment(appScope(ids.appId), ids.environmentId, {
    policy: JSON.stringify(policy),
    updatedAt: NOW,
  });
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

async function applyMigrations(d1: D1Database): Promise<void> {
  for (const statement of migrationStatements()) {
    await d1.exec(statement);
  }
}
