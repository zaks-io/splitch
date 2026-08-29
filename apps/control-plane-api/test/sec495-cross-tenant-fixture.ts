import { env } from "cloudflare:workers";
import { appScope, createRepository, envScope, type Repository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { type ConfigStoreDeps, type ConfigStoreWriter, makeConfigStore } from "../src/config-store";
import {
  type ConfigStoreAccess,
  type ConfigStoreDurableObjectNamespace,
  durableConfigStoreAccess,
} from "../src/config-store-access";
import { makeDurableSnapshotRevisionAllocator } from "../src/config-store-snapshot-revision";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { appAdminScope } from "../src/scope-binding";
import { makeSessionStore } from "../src/session-store";
import { resetOrganizationGraph } from "../src/test-seeds";
import { seedSecurityTenants, type Tenant } from "./sec495-cross-tenant-seed";

const AUDIENCE = "https://cp.splitch.test";
const NOW = "2026-07-01T20:00:00.000Z";
const NOW_MS = Date.parse(NOW);

let d1: D1Database;
let kv: KVNamespace;
let repo: Repository;
let signer: FixtureSigner;

const allowLimiter: RateLimiter = () => ({ limited: false });

export async function setupSecurityFixture(): Promise<void> {
  d1 = env.DB;
  kv = env.CONFIG_STORE;
  await resetOrganizationGraph(d1);
  await clearKv();
  repo = createRepository(d1);
  signer = await makeFixtureSigner();
  await seedSecurityTenants(repo, d1);
}

export async function teardownSecurityFixture(): Promise<void> {
  await clearKv();
}

export function securityKv(): KVNamespace {
  return kv;
}

export interface World {
  access: ConfigStoreAccess;
  app: Hono;
  names: string[];
}

export function makeWorld(
  options: {
    sharedWriteThrough?: boolean;
    error?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
  } = {},
): World {
  const names: string[] = [];
  const writers = new Map<string, ConfigStoreWriter>();
  const namespace = {
    getByName(name: string) {
      names.push(name);
      let writer = writers.get(name);
      if (!writer) {
        writer = makeConfigStore({
          repo,
          kv,
          broadcaster: { broadcast: () => undefined },
          nextSnapshotRevision: durableRevisionAllocator(),
          now: () => new Date(NOW_MS),
        });
        writers.set(name, writer);
      }
      return writer;
    },
  } as unknown as ConfigStoreDurableObjectNamespace;
  const hasLogger = options.error !== undefined || options.warn !== undefined;
  const access = durableConfigStoreAccess(namespace, kv, {
    repo,
    waitUntil: (promise) => void promise,
    ...(options.sharedWriteThrough ? {} : { writeThrough: new Map() }),
    ...(hasLogger
      ? {
          logger: {
            error: options.error ?? console.error,
            warn: options.warn ?? console.warn,
          },
        }
      : {}),
  });
  const app = createApp({
    authResolver: makeControlPlaneAuthResolver({
      verifier: makeJwksVerifier({
        fetchJwks: async () => signer.jwks,
        controlPlaneAudience: AUDIENCE,
      }),
      sessions: makeSessionStore({ get: async () => null } as unknown as KVNamespace),
      membershipAccess: { authorize: async () => true },
      now: () => NOW_MS,
    }),
    rateLimiter: allowLimiter,
    repo,
    configStore: access,
  });
  return { access, app, names };
}

export async function publish(world: World, tenant: Tenant): Promise<void> {
  await publishIn(world, tenant, tenant.envId);
}

export async function publishIn(
  world: World,
  tenant: Tenant,
  environmentId: string,
): Promise<void> {
  const result = await world.access.writerFor(tenant.appId, environmentId).resyncFlagConfig({
    appId: tenant.appId,
    environmentId,
    flagId: tenant.flagId,
  });
  if (!result.ok) throw new Error(`security fixture publish failed: ${JSON.stringify(result)}`);
}

export async function seedSecondEnvironment(tenant: Tenant): Promise<void> {
  const environmentId = `${tenant.envId}_dev`;
  await repo.identity.environments.insert(appScope(tenant.appId), {
    id: environmentId,
    appId: tenant.appId,
    key: `${tenant.appId}-dev`,
    name: `${tenant.appId} development`,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.flagConfigs.insert(envScope(tenant.appId, environmentId), {
    id: `${tenant.configId}_dev`,
    appId: tenant.appId,
    environmentId,
    flagId: tenant.flagId,
    enabled: true,
    availableVariantNames: JSON.stringify([tenant.controlVariantName]),
    defaultVariantId: tenant.controlVariantId,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

export async function get(
  app: Hono,
  actor: Tenant,
  appId: string,
  environmentId: string,
  flagId: string,
): Promise<Response> {
  const jwt = await signer.sign({
    sub: actor.userId,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: Math.floor(NOW_MS / 1000),
    exp: Math.floor(NOW_MS / 1000) + 3600,
    scopes: [appAdminScope(actor.appId)],
  });
  const path = `/apps/${encodeURIComponent(appId)}/envs/${encodeURIComponent(environmentId)}/flags/${encodeURIComponent(flagId)}/config`;
  return app.request(path, { headers: { authorization: `Bearer ${jwt}` } });
}

function durableRevisionAllocator(): ConfigStoreDeps["nextSnapshotRevision"] {
  const values = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (entries: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(entries)) values.set(key, value);
    },
  } as unknown as DurableObjectStorage;
  return makeDurableSnapshotRevisionAllocator(storage);
}

async function clearKv(): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await kv.list(cursor ? { cursor } : undefined);
    await Promise.all(page.keys.map((key) => kv.delete(key.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}
