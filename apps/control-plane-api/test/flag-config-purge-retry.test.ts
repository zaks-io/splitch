import { flagConfigKey } from "@splitch/contracts";
import { appScope, createRepository } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfigStoreWriter } from "../src/config-store";
import type { ConfigStoreAccess } from "../src/config-store-access";
import {
  captureFlagConfigPurgeTargets,
  deleteFlagD1Cascade,
  FlagConfigPurgeIncompleteError,
  purgeFlagConfigsKvForKey,
} from "../src/flag-config-lifecycle";
import { createFlag, makeAppForRepo, request } from "../src/flag-definition-test-harness";
import {
  configStoreAccess,
  type LifecycleHarness,
  lifecycleAppToken,
  lifecycleCreateDefaultApp,
  setup,
} from "./flag-config-lifecycle-harness";

let h: LifecycleHarness;

beforeEach(async () => {
  h = await setup();
});

afterEach(async () => h.bindings.dispose());

describe("Flag Configuration KV purge retries", () => {
  it("continues purging later Environments after a middle Environment fails", async () => {
    const fixture = await seedDeletedFlagWithSnapshots();
    const middleEnvironmentId = fixture.environmentIds[1];
    const laterEnvironmentId = fixture.environmentIds[2];
    const { access, attempts } = faultingDeleteAccess(fixture.access, {
      [middleEnvironmentId]: Number.POSITIVE_INFINITY,
    });

    await expect(
      purgeFlagConfigsKvForKey(
        { repo: fixture.repo, configStore: access },
        fixture.appId,
        fixture.flagId,
        fixture.flagKey,
        fixture.purgeTargets,
      ),
    ).rejects.toBeInstanceOf(FlagConfigPurgeIncompleteError);

    expect(attempts.get(middleEnvironmentId)).toBe(3);
    expect(attempts.get(laterEnvironmentId)).toBe(1);
    expect(await snapshot(fixture, laterEnvironmentId)).toBeNull();
  });

  it("retries a transient Environment failure and removes its snapshot", async () => {
    const fixture = await seedDeletedFlagWithSnapshots();
    const transientEnvironmentId = fixture.environmentIds[1];
    const { access, attempts } = faultingDeleteAccess(fixture.access, {
      [transientEnvironmentId]: 1,
    });

    await expect(
      purgeFlagConfigsKvForKey(
        { repo: fixture.repo, configStore: access },
        fixture.appId,
        fixture.flagId,
        fixture.flagKey,
        fixture.purgeTargets,
      ),
    ).resolves.toBeUndefined();

    expect(attempts.get(transientEnvironmentId)).toBe(2);
    expect(await snapshot(fixture, transientEnvironmentId)).toBeNull();
  });

  it("reports every Environment that remains un-purged", async () => {
    const fixture = await seedDeletedFlagWithSnapshots();
    const failedEnvironmentIds = [fixture.environmentIds[0], fixture.environmentIds[2]];
    const { access } = faultingDeleteAccess(fixture.access, {
      [failedEnvironmentIds[0]]: Number.POSITIVE_INFINITY,
      [failedEnvironmentIds[1]]: Number.POSITIVE_INFINITY,
    });

    const error = await purgeFlagConfigsKvForKey(
      { repo: fixture.repo, configStore: access },
      fixture.appId,
      fixture.flagId,
      fixture.flagKey,
      fixture.purgeTargets,
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(FlagConfigPurgeIncompleteError);
    expect(error).toMatchObject({
      appId: fixture.appId,
      flagId: fixture.flagId,
      flagKey: fixture.flagKey,
      environmentIds: failedEnvironmentIds,
    });
    expect((error as Error).message).toContain(fixture.flagKey);
    for (const environmentId of failedEnvironmentIds) {
      expect((error as Error).message).toContain(environmentId);
    }
    expect((error as FlagConfigPurgeIncompleteError).failures).toHaveLength(2);
    expect((error as Error).cause).toBeInstanceOf(AggregateError);
  });

  it("preserves a Flag re-created under the same key while purge is in flight", async () => {
    const fixture = await seedDeletedFlagWithSnapshots();
    const paused = pausingDeleteAccess(fixture.access, fixture.environmentIds[0]);
    const purge = purgeFlagConfigsKvForKey(
      { repo: fixture.repo, configStore: paused.access },
      fixture.appId,
      fixture.flagId,
      fixture.flagKey,
      fixture.purgeTargets,
    );
    await paused.entered;

    const recreated = await createFlag(h, fixture.appId, fixture.jwt);
    expect(recreated.id).not.toBe(fixture.flagId);
    paused.release();
    await expect(purge).resolves.toBeUndefined();

    for (const environmentId of fixture.environmentIds) {
      expect(JSON.parse((await snapshot(fixture, environmentId)) ?? "null")).toMatchObject({
        data: { id: recreated.id },
      });
    }
  });

  it("preserves a re-created Flag's key when KV still shows the deleted owner", async () => {
    const fixture = await seedDeletedFlagWithSnapshots();
    const pausedEnvironmentId = fixture.environmentIds[0];
    if (!pausedEnvironmentId) throw new Error("expected an Environment");
    const deletedOwnerSnapshot = await snapshot(fixture, pausedEnvironmentId);
    expect(deletedOwnerSnapshot).not.toBeNull();
    const paused = pausingDeleteAccess(fixture.access, pausedEnvironmentId);
    const purge = purgeFlagConfigsKvForKey(
      { repo: fixture.repo, configStore: paused.access },
      fixture.appId,
      fixture.flagId,
      fixture.flagKey,
      fixture.purgeTargets,
    );
    await paused.entered;

    const recreated = await createFlag(h, fixture.appId, fixture.jwt);
    expect(recreated.id).not.toBe(fixture.flagId);
    if (deletedOwnerSnapshot === null) throw new Error("expected the deleted owner's snapshot");
    await h.bindings.configKv.put(
      flagConfigKey(fixture.appId, pausedEnvironmentId, fixture.flagKey),
      deletedOwnerSnapshot,
    );
    paused.release();
    await expect(purge).resolves.toBeUndefined();

    expect(await snapshot(fixture, pausedEnvironmentId)).toBe(deletedOwnerSnapshot);
  });
});

async function seedDeletedFlagWithSnapshots() {
  const createdApp = await lifecycleCreateDefaultApp(h);
  const jwt = await lifecycleAppToken(h, createdApp.app.id);
  const repo = createRepository(h.bindings.d1);
  const access = configStoreAccess(h.bindings);
  h.app = makeAppForRepo(h, repo, access, h.bindings.credentialKv);

  const stagingResponse = await request(h, "POST", `/apps/${createdApp.app.id}/envs`, jwt, {
    key: "staging",
    name: "Staging",
  });
  expect(stagingResponse.status).toBe(200);

  const flag = await createFlag(h, createdApp.app.id, jwt);
  const environments = await repo.identity.listEnvironments(appScope(createdApp.app.id));
  expect(environments).toHaveLength(3);
  for (const environment of environments) {
    expect(
      await h.bindings.configKv.get(
        flagConfigKey(createdApp.app.id, environment.id, flag.key),
        "text",
      ),
    ).not.toBeNull();
  }

  const purgeTargets = await captureFlagConfigPurgeTargets(
    { repo, configStore: access },
    createdApp.app.id,
    flag.id,
  );
  await deleteFlagD1Cascade({ repo }, createdApp.app.id, flag.id);
  return {
    access,
    appId: createdApp.app.id,
    environmentIds: environments.map((environment) => environment.id),
    flagId: flag.id,
    flagKey: flag.key,
    jwt,
    purgeTargets,
    repo,
  };
}

function pausingDeleteAccess(base: ConfigStoreAccess, pausedEnvironmentId: string) {
  let release = () => {
    throw new Error("purge release was not initialized");
  };
  let markEntered = () => {
    throw new Error("purge entry was not initialized");
  };
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    access: {
      readFlagConfig: (input) => base.readFlagConfig(input),
      liveUpdatesFor: (appId, environmentId) => base.liveUpdatesFor(appId, environmentId),
      writerFor(appId: string, environmentId: string) {
        const writer = base.writerFor(appId, environmentId);
        if (environmentId !== pausedEnvironmentId) return writer;
        return new Proxy(writer, {
          get(target, property, receiver) {
            if (property !== "deleteFlagConfig") return Reflect.get(target, property, receiver);
            return async (input: Parameters<ConfigStoreWriter["deleteFlagConfig"]>[0]) => {
              markEntered();
              await gate;
              return writer.deleteFlagConfig(input);
            };
          },
        });
      },
    } satisfies ConfigStoreAccess,
  };
}

function faultingDeleteAccess(
  base: ConfigStoreAccess,
  failuresByEnvironment: Readonly<Record<string, number>>,
): { access: ConfigStoreAccess; attempts: Map<string, number> } {
  const attempts = new Map<string, number>();
  return {
    attempts,
    access: {
      readFlagConfig: (input) => base.readFlagConfig(input),
      liveUpdatesFor: (appId, environmentId) => base.liveUpdatesFor(appId, environmentId),
      writerFor(appId, environmentId) {
        const writer = base.writerFor(appId, environmentId);
        return new Proxy(writer, {
          get(target, property, receiver) {
            if (property !== "deleteFlagConfig") return Reflect.get(target, property, receiver);
            return async (input: Parameters<ConfigStoreWriter["deleteFlagConfig"]>[0]) => {
              const attempt = (attempts.get(environmentId) ?? 0) + 1;
              attempts.set(environmentId, attempt);
              if (attempt <= (failuresByEnvironment[environmentId] ?? 0)) {
                return { ok: false as const, reason: "FLAG_NOT_FOUND" as const };
              }
              return writer.deleteFlagConfig(input);
            };
          },
        });
      },
    },
  };
}

function snapshot(
  fixture: Awaited<ReturnType<typeof seedDeletedFlagWithSnapshots>>,
  environmentId: string,
) {
  return h.bindings.configKv.get(
    flagConfigKey(fixture.appId, environmentId, fixture.flagKey),
    "text",
  );
}
