import { canonicalHash } from "@splitch/contracts";
import { createRepository, envScope } from "@splitch/db";
import { expect, it } from "vitest";
import { approvalTargetVersion } from "../src/approval-target";
import { type ConfigStoreWriter, makeConfigStore } from "../src/config-store";
import {
  makeSnapshotRevisionCounter,
  narrowSeededAvailability,
} from "../src/config-store-fixture-data";
import {
  ids,
  makeAuthedApp,
  NOW_MS,
  patchFlagConfig,
  setProdPolicy,
} from "../src/config-store-harness-core";
import { makeConfigStoreProjectionJournalFixture } from "../src/config-store-projection-journal-fixture";
import { makePoolHarness } from "./config-store-pool-harness";
import { countD1RoundTrips } from "./d1-round-trips";

it("batches reads for the same pending Approval PATCH and direct PATCH over local D1", async () => {
  const fixture = await makePoolHarness();
  await narrowSeededAvailability(fixture.d1);
  const counted = countD1RoundTrips(fixture.d1);
  const repo = createRepository(counted.d1);
  const calls: string[] = [];
  const store = new Proxy(
    makeConfigStore({
      repo,
      kv: fixture.kv,
      projectionJournal: makeConfigStoreProjectionJournalFixture(),
      broadcaster: { broadcast: () => undefined },
      nextSnapshotRevision: makeSnapshotRevisionCounter(),
      now: () => new Date(NOW_MS),
    }),
    {
      get(target, property: keyof ConfigStoreWriter) {
        return (...args: unknown[]) => {
          calls.push(property);
          return Reflect.apply(target[property], target, args);
        };
      },
    },
  );
  const h = { ...fixture, repo, app: makeAuthedApp({ ...fixture, repo }, store) };
  await setProdPolicy(h, {
    variantAvailability: "confirm",
    targetingRolloutValue: "confirm",
    enabledState: "confirm",
    startExperimentRun: "confirm",
  });
  counted.reset();
  const pending = await patchFlagConfig(h, { availableVariantNames: ["control"] });
  expect(pending.status, await pending.clone().text()).toBe(409);
  expect(await pending.json()).toMatchObject({ code: "APPROVAL_REVIEW_REQUIRED" });
  expect(calls).toEqual(["readFlagConfig", "previewFlagConfig"]);
  expect(counted.statements).toHaveLength(20);
  expect(counted.statements.flat()).toHaveLength(35);
  counted.reset();
  calls.length = 0;
  const direct = await patchFlagConfig(h, { enabled: false }, "idem_round_trip_direct");
  expect(direct.status, await direct.clone().text()).toBe(200);
  expect(await direct.json()).toMatchObject({
    flagId: ids.flagId,
    enabled: false,
    approvalRequest: null,
  });
  expect(calls).toEqual(["writeFlagConfig"]);
  expect(counted.statements).toHaveLength(15);
  expect(counted.statements.flat()).toHaveLength(23);
});

it("keeps the Approval target hash and App/Environment boundaries in one read batch", async () => {
  const fixture = await makePoolHarness();
  const counted = countD1RoundTrips(fixture.d1);
  const repo = createRepository(counted.d1);
  const contexts = [
    { environmentId: ids.environmentId, changeTypes: ["enabled_state"], level: "allow" },
  ] as const;
  const target = { type: "flag_configuration", id: ids.configId } as const;

  expect(
    await approvalTargetVersion(repo, ids.appId, target, [
      { ...contexts[0], changeTypes: ["enabled_state"] },
    ]),
  ).toBe(
    await canonicalHash({
      flagConfigVersion: 1,
      policy: [{ environmentId: ids.environmentId, changeType: "enabled_state", level: "allow" }],
    }),
  );
  expect(counted.statements).toHaveLength(1);
  expect(counted.statements[0]).toHaveLength(2);

  for (const scope of [
    envScope(ids.otherAppId, ids.environmentId),
    envScope(ids.appId, ids.devEnvironmentId),
  ]) {
    const result = await repo.flags.readFlagConfigReviewContext(scope, ids.configId);
    expect(result.config).toBeNull();
    if (scope.appId === ids.otherAppId) {
      expect(result.environment).toBeNull();
      expect(await repo.flags.readFlagSnapshotInputs(scope, ids.flagId)).toBeNull();
    }
  }
});
