import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeConfigStore } from "../src/config-store";
import { startSeededExperiment } from "../src/config-store-fixture-data";
import {
  type Harness,
  ids,
  promoteFlagConfig,
  setProdPolicy,
} from "../src/config-store-harness-core";
import { allowPolicy } from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

/**
 * SPL-267. A Promotion with `select: {}` moves no field group, so a live Run
 * freezes nothing it touches and it is correctly NOT refused. It must also not
 * write: bumping `flag_configs.version` invalidates the concurrency token every
 * pending Approval Request on this Flag Configuration holds, on behalf of a
 * caller who changed nothing.
 */

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  await setProdPolicy(h, allowPolicy);
});

afterEach(async () => {
  await h.dispose();
});

async function prodVersion(): Promise<number | undefined> {
  const config = await h.repo.flags.getFlagConfig(
    envScope(ids.appId, ids.environmentId),
    ids.flagId,
  );
  return config?.version;
}

describe("Promotion that selects no field group", () => {
  it("leaves the target's version untouched while a Run is live", async () => {
    await startSeededExperiment(h.d1);
    const before = await prodVersion();

    const promoted = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: {},
    });

    expect(promoted.status).toBe(200);
    expect(await prodVersion()).toBe(before);
    expect(await promoted.json()).toMatchObject({ version: before });
  });

  it("previews the version it will actually leave behind", async () => {
    const before = await prodVersion();
    const store = makeConfigStore({
      repo: h.repo,
      kv: h.kv,
      broadcaster: { broadcast: () => undefined },
    });

    const preview = await store.previewPromotion({
      appId: ids.appId,
      flagId: ids.flagId,
      fromEnvironmentId: ids.devEnvironmentId,
      targetEnvironmentId: ids.environmentId,
      select: {},
    });

    expect(preview).toMatchObject({ ok: true, diff: { after: { version: before } } });
  });
});
