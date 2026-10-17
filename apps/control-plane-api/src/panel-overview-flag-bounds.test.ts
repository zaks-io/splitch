import { appScope } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import { ATTENTION_TEST_TIMEOUT, repository } from "./attention-rollup-fixture";
import { ids, NOW, NOW_MS } from "./config-store-fixture-data";
import { seedOverviewEvent, setupOverviewFixture } from "./overview-flag-change-test-fixture";
import {
  FLAG_CHANGE_LIMIT,
  FLAG_CHANGE_READ_LIMIT,
  FLAG_CHANGE_WINDOW_DAYS,
} from "./overview-thresholds";
import { body, CALM, overview, readerFor } from "./panel-overview-fixture";

setupOverviewFixture();

const DAY_MS = 86_400_000;

async function seedEvents(count: number, changedAt: (index: number) => string = () => NOW) {
  for (let index = 0; index < count; index += 1) {
    await seedOverviewEvent({ flagKey: `bulk-flag-${index}`, changedAt: changedAt(index) });
  }
}

const read = () => overview(readerFor({ [ids.liveRunId]: CALM }));

describe("panelOverviewRead Flag change-log bounds", () => {
  it(
    "observes read truncation and keeps the newest sequences",
    async () => {
      await seedEvents(FLAG_CHANGE_READ_LIMIT);
      const { flagConfiguration: changes } = await body(await read());

      expect(changes.readTruncated).toBe(true);
      expect(changes.readLimit).toBe(FLAG_CHANGE_READ_LIMIT);
      expect(changes.changedCount).toBe(FLAG_CHANGE_READ_LIMIT);
      expect(changes.recentlyChanged.map((change) => change.flagKey)).toEqual([
        "bulk-flag-49",
        "bulk-flag-48",
        "bulk-flag-47",
        "bulk-flag-46",
        "bulk-flag-45",
      ]);
      expect((await body(await read())).flagConfiguration.recentlyChanged).toEqual(
        changes.recentlyChanged,
      );
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "does not infer truncation from a full page",
    async () => {
      await seedEvents(FLAG_CHANGE_READ_LIMIT - 1);
      const { flagConfiguration: changes } = await body(await read());

      expect(changes.readTruncated).toBe(false);
      expect(changes.changedCount).toBe(FLAG_CHANGE_READ_LIMIT);
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "filters old events in SQL before applying the bound",
    async () => {
      await seedEvents(FLAG_CHANGE_READ_LIMIT + 5, (index) =>
        new Date(NOW_MS - (30 + index) * DAY_MS).toISOString(),
      );
      const { flagConfiguration: changes } = await body(await read());

      expect(changes.readTruncated).toBe(false);
      expect(changes.changedCount).toBe(1);
      expect(changes.recentlyChanged[0]?.flagKey).toBe(ids.flagKey);
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "reports display truncation while counting repeated changes to one Flag",
    async () => {
      await seedEvents(11);
      const { flagConfiguration: changes } = await body(await read());

      expect(changes.changedCount).toBe(12);
      expect(changes.recentlyChanged).toHaveLength(FLAG_CHANGE_LIMIT);
      expect(changes.readTruncated).toBe(false);
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "includes shared definitions and deleted Flags, and excludes other scopes and future events",
    async () => {
      await seedOverviewEvent({ targetType: "flag", action: "created", environmentId: null });
      await seedOverviewEvent({
        flagId: "flag_deleted",
        flagKey: "deleted-flag",
        targetType: "flag",
        action: "deleted",
        environmentId: null,
        actorRef: "deleted:user",
        actorVia: "session",
      });
      await seedOverviewEvent({ environmentId: ids.devEnvironmentId, flagKey: "dev-only" });
      await seedOverviewEvent({ appId: ids.otherAppId, flagKey: "other-app" });
      await seedOverviewEvent({
        flagKey: "future",
        changedAt: new Date(NOW_MS + DAY_MS).toISOString(),
      });
      await seedOverviewEvent({
        flagKey: "window-boundary",
        changedAt: new Date(NOW_MS - FLAG_CHANGE_WINDOW_DAYS * DAY_MS).toISOString(),
      });

      const { flagConfiguration: changes } = await body(await read());

      expect(changes.changedCount).toBe(4);
      expect(changes.recentlyChanged.map((change) => change.flagKey)).toEqual([
        "window-boundary",
        "deleted-flag",
        ids.flagKey,
        ids.flagKey,
      ]);
      expect(changes.recentlyChanged[1]).toMatchObject({
        action: "deleted",
        actorRef: "deleted:user",
        actorVia: "session",
      });
      expect(changes.recentlyChanged[2]).toMatchObject({ action: "created", actorRef: null });
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "uses one bounded authoritative read and no live Flag or Configuration reads",
    async () => {
      const repo = repository();
      const listForApp = vi.fn(repo.flagChangeEvents.listForApp.bind(repo.flagChangeEvents));
      const listRecentFlagConfigs = vi.fn(repo.flags.listRecentFlagConfigs);
      const listFlagsByIds = vi.fn(repo.flags.listFlagsByIds);
      const response = await overview(readerFor({ [ids.liveRunId]: CALM }), {
        repo: {
          ...repo,
          flagChangeEvents: { ...repo.flagChangeEvents, listForApp },
          flags: { ...repo.flags, listRecentFlagConfigs, listFlagsByIds },
        },
      });

      expect(response.status).toBe(200);
      expect(listForApp).toHaveBeenCalledExactlyOnceWith(appScope(ids.appId), {
        from: new Date(NOW_MS - FLAG_CHANGE_WINDOW_DAYS * DAY_MS).toISOString(),
        to: NOW,
        environmentIds: [ids.environmentId],
        includeAppLevel: true,
        order: "desc",
        limit: FLAG_CHANGE_READ_LIMIT + 1,
      });
      expect(listRecentFlagConfigs).not.toHaveBeenCalled();
      expect(listFlagsByIds).not.toHaveBeenCalled();
    },
    ATTENTION_TEST_TIMEOUT,
  );
});
