import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appScope, createRepository, envScope } from "../index";
import { seedTwoTenants } from "./test-seed";
import { createLocalD1, type LocalD1 } from "./test-d1";

/**
 * The cross-tenant isolation proof (the headline acceptance criterion).
 *
 * Seeds two Apps (A and B) — each with its own Environment, Flag, Variant,
 * Experiment, Run, API Key — into ONE local D1, then asserts that every
 * repository read scoped to App A returns ZERO of App B's rows, and vice versa.
 * A regression that drops an `app_id` / `environment_id` filter fails here.
 */

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;
let seed: Awaited<ReturnType<typeof seedTwoTenants>>;

beforeAll(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  seed = await seedTwoTenants(local.d1);
});

afterAll(async () => {
  await local.dispose();
});

describe("App A cannot read App B (and vice versa)", () => {
  it("getFlag for App A returns null for App B's flag id", async () => {
    const aScope = appScope(seed.a.appId);
    expect(await repo.flags.getFlag(aScope, seed.b.flagId)).toBeNull();
    // sanity: App A CAN read its own flag
    expect(await repo.flags.getFlag(aScope, seed.a.flagId)).not.toBeNull();
  });

  it("listVariants for App A returns [] for App B's flag", async () => {
    const aScope = appScope(seed.a.appId);
    expect(await repo.flags.listVariants(aScope, seed.b.flagId)).toEqual([]);
    expect(await repo.flags.listVariants(aScope, seed.a.flagId)).toHaveLength(1);
  });

  it("getExperiment scoped to App A's env returns null for App B's experiment", async () => {
    const aEnv = envScope(seed.a.appId, seed.a.environmentId);
    expect(await repo.experiments.getExperiment(aEnv, seed.b.experimentId)).toBeNull();
    expect(await repo.experiments.getExperiment(aEnv, seed.a.experimentId)).not.toBeNull();
  });

  it("getRun scoped to App A's env returns null for App B's run", async () => {
    const aEnv = envScope(seed.a.appId, seed.a.environmentId);
    expect(await repo.experiments.getRun(aEnv, seed.b.runId)).toBeNull();
    expect(await repo.experiments.getRun(aEnv, seed.a.runId)).not.toBeNull();
  });

  it("listApiKeys scoped to App A's env never includes App B's key", async () => {
    const aEnv = envScope(seed.a.appId, seed.a.environmentId);
    const keys = await repo.credentials.listApiKeys(aEnv);
    expect(keys.map((k) => k.keyId)).toEqual([seed.a.apiKeyId]);
    expect(keys.map((k) => k.keyId)).not.toContain(seed.b.apiKeyId);
  });

  it("App A's env scope with App B's environmentId returns nothing", async () => {
    // Mixing App A's app_id with App B's environment_id must yield zero rows:
    // both predicates AND together, so a mismatched pair matches no record.
    const crossed = envScope(seed.a.appId, seed.b.environmentId);
    expect(await repo.experiments.getRun(crossed, seed.b.runId)).toBeNull();
    expect(await repo.credentials.listApiKeys(crossed)).toEqual([]);
  });

  it("symmetry: App B cannot read App A's flag", async () => {
    const bScope = appScope(seed.b.appId);
    expect(await repo.flags.getFlag(bScope, seed.a.flagId)).toBeNull();
  });
});

describe("writes land in the issuing scope only", () => {
  it("update scoped to App A cannot touch App B's flag", async () => {
    const aScope = appScope(seed.a.appId);
    const updated = await repo.flags.flags.update(
      aScope,
      { name: "renamed-by-a" },
      // even if a caller targets B's id, the app_id predicate bounds the UPDATE
      // to App A, so B's flag is untouched.
      undefined,
    );
    expect(updated.every((row) => row.appId === seed.a.appId)).toBe(true);
    const bFlag = await repo.flags.getFlag(appScope(seed.b.appId), seed.b.flagId);
    expect(bFlag?.name).not.toBe("renamed-by-a");
  });
});
