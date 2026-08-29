import { type DeltaNudge, type EnvironmentPolicy, flagConfigKey } from "@splitch/contracts";
import { appScope, createRepository, envScope, type Repository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { createApp } from "./app";
import type { ApprovalArchiveStore } from "./approval-archive";
import { makeControlPlaneAuthResolver } from "./auth-resolver";
import { type ConfigStoreWriter, makeConfigStore } from "./config-store";
import {
  ids,
  makeSnapshotRevisionCounter,
  NOW,
  NOW_MS,
  startSeededExperiment,
} from "./config-store-fixture-data";
import { type FixtureSigner, makeFixtureSigner } from "./fixture-signer";
import { makeJwksVerifier } from "./jwks-verify";
import { appAdminScope } from "./scope-binding";
import { makeSessionStore } from "./session-store";

const AUDIENCE = "https://cp.splitch.test";
const TEST_IDEMPOTENCY_KEY = "idem_config_store_test";
export const USER_ID = "user_config_admin";

export { ids, NOW, NOW_MS, startSeededExperiment };

export interface Harness {
  app: Hono;
  d1: D1Database;
  kv: KVNamespace;
  repo: Repository;
  signer: FixtureSigner;
  dispose: () => Promise<void>;
  nudges: DeltaNudge[];
  errors: unknown[][];
  warnings: unknown[][];
  events: string[];
}

const allowLimiter: RateLimiter = () => ({ limited: false });

/**
 * Wire an already-seeded set of bindings into the Harness the tests drive.
 *
 * Split out so the Workers-pool harness can reuse it: everything below this
 * point is runtime-agnostic, and only the seeding above differs between a
 * Miniflare instance and workerd's in-process bindings.
 */
export async function buildHarness(bindings: {
  d1: D1Database;
  kv: KVNamespace;
  sessions: KVNamespace;
  dispose: () => Promise<void>;
}): Promise<Harness> {
  const { d1, kv, sessions } = bindings;
  const repo = createRepository(d1);
  const signer = await makeFixtureSigner();
  const nudges: DeltaNudge[] = [];
  const errors: unknown[][] = [];
  const warnings: unknown[][] = [];
  const events: string[] = [];
  const recordedKv = recordingKv(kv, repo, events);
  const stores = new Map<string, ConfigStoreWriter>();
  const writerFor = (appId: string, environmentId: string): ConfigStoreWriter => {
    const name = `${appId}:${environmentId}`;
    let store = stores.get(name);
    if (!store) {
      store = makeConfigStore({
        repo,
        kv: recordedKv,
        broadcaster: {
          broadcast(nudge) {
            events.push("broadcast");
            nudges.push(nudge);
          },
        },
        nextSnapshotRevision: makeSnapshotRevisionCounter(),
        logger: {
          error: (...args: unknown[]) => errors.push(args),
          warn: (...args: unknown[]) => warnings.push(args),
        },
        now: () => new Date(NOW_MS),
      });
      stores.set(name, store);
    }
    return store;
  };
  const store = writerFor(ids.appId, ids.environmentId);

  const app = makeAuthedApp({ repo, signer, sessions }, store, undefined, writerFor);
  return { app, d1, kv, repo, signer, nudges, errors, warnings, events, dispose: bindings.dispose };
}

export function makeAuthedApp(
  h: Pick<Harness, "repo" | "signer"> & { sessions?: KVNamespace },
  store?: ConfigStoreWriter,
  approvalArchiveStore?: ApprovalArchiveStore,
  scopedWriterFor?: (appId: string, environmentId: string) => ConfigStoreWriter,
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
      membershipAccess: { authorize: async () => true },
      now: () => NOW_MS,
    }),
    rateLimiter: allowLimiter,
    repo: h.repo,
    ...(store
      ? {
          configStore: {
            readFlagConfig: (input) => store.readFlagConfig(input),
            writerFor:
              scopedWriterFor ??
              ((appId, environmentId) => {
                if (appId !== ids.appId || environmentId !== ids.environmentId) {
                  throw new Error("config-store harness received an unexpected writer scope");
                }
                return store;
              }),
            liveUpdatesFor: () => ({
              connect: async () => new Response("test live updates unavailable", { status: 503 }),
            }),
          },
        }
      : {}),
    ...(approvalArchiveStore ? { approvalArchiveStore } : {}),
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
  const requestBody = approvalMutationBody(body);
  return h.app.request(
    `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/targeting-rules`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "idempotency-key": TEST_IDEMPOTENCY_KEY,
      },
      body: JSON.stringify(requestBody),
    },
  );
}

export async function promoteFlagConfig(
  h: Harness,
  body: Record<string, unknown>,
): Promise<Response> {
  const jwt = await token(h.signer);
  const requestBody = approvalMutationBody(body);
  return h.app.request(`/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/promote`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "idempotency-key": TEST_IDEMPOTENCY_KEY,
    },
    body: JSON.stringify(requestBody),
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
  const requestBody = approvalMutationBody(body);
  return app.request(`/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/config`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "idempotency-key": TEST_IDEMPOTENCY_KEY,
    },
    body: JSON.stringify(requestBody),
  });
}

function approvalMutationBody(body: Record<string, unknown>): Record<string, unknown> {
  return { idempotency_key: TEST_IDEMPOTENCY_KEY, ...body };
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
      if (prop !== "put") {
        // Bound to the target: workerd's real KVNamespace is a host object whose
        // methods reject a foreign `this`, so handing back the bare function
        // would make every non-`put` call through this proxy throw.
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      }
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
