import { apiKeyCacheKey } from "@splitch/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appToken,
  createDefaultApp,
  credentialCreatingOnFirstTombstone,
  h,
  makeApp,
  readCache,
  request,
  setup,
  teardown,
} from "../src/app-environment-credential-revocation.fixtures";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

beforeEach(() => setup(makeLocalBindings));
afterEach(teardown);

describe("control-plane parent delete credential race", () => {
  it.each([
    "Environment",
    "App",
  ])("tombstones credentials created after the %s delete snapshot", async (parent) => {
    const created = await createDefaultApp(`late-credential-${parent.toLowerCase()}`);
    const dev = created.environments.find((env) => env.key === "dev");
    expect(dev).toBeDefined();
    const lateCacheKey = apiKeyCacheKey("api-key-created-during-delete");
    h.app = makeApp(
      h.bindings,
      h.signer,
      credentialCreatingOnFirstTombstone(h.bindings.credentialKv, created.app.id, dev?.id ?? ""),
    );

    const res =
      parent === "Environment"
        ? await request(
            "DELETE",
            `/apps/${created.app.id}/envs/${dev?.id}`,
            await appToken(created.app.id),
          )
        : await request("DELETE", `/apps/${created.app.id}`, await appToken(created.app.id));

    expect(res.status).toBe(200);
    expect((await readCache(h.bindings.credentialKv, lateCacheKey))?.data).toMatchObject({
      kind: "api_key",
      revoked: true,
    });
  });
});
