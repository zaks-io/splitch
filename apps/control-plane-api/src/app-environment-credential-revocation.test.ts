import { appScope, createRepository, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ORG,
  appToken,
  bodyOf,
  clientCacheKey,
  createApiKey,
  createDefaultApp,
  faultingPutKv,
  h,
  makeApp,
  readCache,
  request,
  setup,
  teardown,
} from "./app-environment-credential-revocation.fixtures";

beforeEach(setup);
afterEach(teardown);

describe("control-plane parent delete credential revocation", () => {
  it("writes revoked KV tombstones before deleting Environment credentials", async () => {
    const created = await createDefaultApp("env-credential-revoke");
    const dev = created.environments.find((env) => env.key === "dev");
    expect(dev).toBeDefined();
    const clientKey = created.clientKeys.find((key) => key.environmentId === dev?.id);
    expect(clientKey).toBeDefined();
    const apiKey = await createApiKey(created.app.id, dev?.id ?? "");

    const res = await request(
      "DELETE",
      `/apps/${created.app.id}/envs/${dev?.id}`,
      await appToken(created.app.id),
    );
    expect(res.status).toBe(200);

    const clientTombstone = await readCache(
      h.bindings.credentialKv,
      await clientCacheKey(clientKey?.keyMaterial ?? ""),
    );
    expect(clientTombstone?.data).toMatchObject({ kind: "client_key", revoked: true });
    expect((await readCache(h.bindings.credentialKv, apiKey.cacheKey))?.data).toMatchObject({
      kind: "api_key",
      revoked: true,
    });

    const repo = createRepository(h.bindings.d1);
    const scope = envScope(created.app.id, dev?.id ?? "");
    expect(await repo.credentials.listClientKeys(scope)).toHaveLength(0);
    expect(await repo.credentials.listApiKeys(scope)).toHaveLength(0);
  });

  it("writes revoked KV tombstones before deleting App credentials", async () => {
    const created = await createDefaultApp("app-credential-revoke");
    const apiKeys = await Promise.all(
      created.environments.map((env) => createApiKey(created.app.id, env.id)),
    );
    const clientKeys = await Promise.all(
      created.clientKeys.map((key) => clientCacheKey(key.keyMaterial)),
    );

    const res = await request("DELETE", `/apps/${created.app.id}`, await appToken(created.app.id));
    expect(res.status).toBe(200);

    for (const key of clientKeys) {
      expect((await readCache(h.bindings.credentialKv, key))?.data).toMatchObject({
        kind: "client_key",
        revoked: true,
      });
    }
    for (const key of apiKeys.map((apiKey) => apiKey.cacheKey)) {
      expect((await readCache(h.bindings.credentialKv, key))?.data).toMatchObject({
        kind: "api_key",
        revoked: true,
      });
    }
  });

  it("fails loud before parent delete when revoked KV tombstone writes fail", async () => {
    const envDelete = await createDefaultApp("env-credential-fault");
    const env = envDelete.environments.find((candidate) => candidate.key === "dev");
    expect(env).toBeDefined();
    const appDelete = await createDefaultApp("app-credential-fault");
    h.app = makeApp(h.bindings, h.signer, faultingPutKv(h.bindings.credentialKv));

    const envRes = await request(
      "DELETE",
      `/apps/${envDelete.app.id}/envs/${env?.id}`,
      await appToken(envDelete.app.id),
    );
    expect(envRes.status).toBe(500);
    expect((await bodyOf(envRes)).code).toBe("INTERNAL_SERVER_ERROR");

    const appRes = await request(
      "DELETE",
      `/apps/${appDelete.app.id}`,
      await appToken(appDelete.app.id),
    );
    expect(appRes.status).toBe(500);
    expect((await bodyOf(appRes)).code).toBe("INTERNAL_SERVER_ERROR");

    const repo = createRepository(h.bindings.d1);
    expect(
      await repo.identity.getEnvironment(appScope(envDelete.app.id), env?.id ?? ""),
    ).toBeTruthy();
    expect(await repo.identity.getApp(appDelete.app.id)).toBeTruthy();
    expect(await repo.identity.listEnvironments(appScope(appDelete.app.id))).toHaveLength(2);
  });
});
