import { appScope, createRepository, envScope, type Repository } from "@splitch/db";
import type { AuthResolver } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { type ConfigStoreWriter, makeConfigStore } from "./config-store";
import type { ConfigStoreAccess } from "./config-store-access";
import {
  ids,
  makeSnapshotRevisionCounter,
  NOW,
  seedConfigGraph,
} from "./config-store-fixture-data";
import { makeTestApp } from "./test-app-fixture";
import { type LocalBindings, makeLocalBindings } from "./test-fixtures";

export { ids, NOW };

interface TemporaryEnvironmentHarness extends LocalBindings {
  repo: Repository;
  faults: unknown[];
  configStore: ConfigStoreAccess;
  credentialStore: KVNamespace;
  exposureStatusCleanup: { delete(): Promise<void> };
  nowIso(): string;
  app: Hono;
  request(path: string, method?: string, body?: unknown): Promise<Response>;
  create(
    key?: string,
    temporary?: Record<string, unknown>,
    extra?: Record<string, unknown>,
  ): Promise<Response>;
  writerFor(appId: string, environmentId: string): ConfigStoreWriter;
  setTime(time: string): void;
  config(environmentId: string): ReturnType<Repository["flags"]["getFlagConfig"]>;
}

export async function temporaryEnvironmentHarness(): Promise<TemporaryEnvironmentHarness> {
  const bindings = await makeLocalBindings();
  await seedConfigGraph(bindings.d1);
  const repo = createRepository(bindings.d1);
  await repo.identity.createAppMembership(appScope(ids.appId), {
    userId: "user_temporary",
    role: "owner",
    createdAt: NOW,
  });
  await repo.identity.createOrgMembership({
    orgId: ids.orgId,
    userId: "user_temporary",
    role: "owner",
    createdAt: NOW,
  });
  let currentTime = NOW;
  const writers = new Map<string, ConfigStoreWriter>();
  const nowIso = () => currentTime;
  const writerFor = (appId: string, environmentId: string) => {
    const name = `${appId}:${environmentId}`;
    let writer = writers.get(name);
    if (!writer) {
      writer = makeConfigStore({
        repo,
        kv: bindings.kv,
        broadcaster: { broadcast() {} },
        now: () => new Date(currentTime),
        nextSnapshotRevision: makeSnapshotRevisionCounter(),
        clearEnvironmentState: async () => undefined,
      });
      writers.set(name, writer);
    }
    return writer;
  };
  const configStore: ConfigStoreAccess = {
    writerFor,
    readFlagConfig: (input) => writerFor(input.appId, input.environmentId).readFlagConfig(input),
    liveUpdatesFor: () => ({ connect: async () => new Response(null, { status: 426 }) }),
  };
  const authResolver: AuthResolver = async () => ({
    ok: true,
    principal: {
      kind: "control-plane-token",
      id: "user_temporary",
      appId: ids.appId,
      orgId: ids.orgId,
      environmentId: null,
      scopes: [`app:${ids.appId}:owner`],
      authDoor: "device_flow",
    },
  });
  const deps = {
    repo,
    configStore,
    credentialStore: bindings.credentialKv,
    nowIso,
    exposureStatusCleanup: { delete: async () => undefined },
  };
  const faults: unknown[] = [];
  const app = makeTestApp({
    ...deps,
    authResolver,
    observability: {
      onError: ({ cause }) => {
        faults.push(cause);
      },
    },
  });
  const request = async (path: string, method = "GET", body?: unknown) =>
    app.request(`/apps/${ids.appId}${path}`, {
      method,
      headers: { "content-type": "application/json", "idempotency-key": "temporary-test-request" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const create = (
    key = "pr-123",
    temporary: Record<string, unknown> = { fromEnvironmentId: "dev" },
    extra = {},
  ) => request("/envs", "POST", { key, temporary, ...extra });
  return {
    ...bindings,
    ...deps,
    faults,
    app,
    request,
    create,
    writerFor,
    setTime: (time: string) => {
      currentTime = time;
    },
    config: (environmentId: string) =>
      repo.flags.getFlagConfig(envScope(ids.appId, environmentId), ids.flagId),
  };
}
