import { envScope, type Repository } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import { buildIntegrationSnapshot } from "./integration-snapshot";

describe("Convex integration snapshot", () => {
  it("loads an Environment in fixed query groups instead of reading once per Flag", async () => {
    const flags = [flag("flag_1", "checkout"), flag("flag_2", "search")];
    const findMany = vi.fn().mockResolvedValue(flags);
    const listFlagConfigsByFlagIds = vi.fn().mockResolvedValue(flags.map(config));
    const listVariantsForFlags = vi
      .fn()
      .mockResolvedValue(new Map(flags.map((row) => [row.id, [variant(row.id)]])));
    const listTargetingRulesByFlagIds = vi.fn().mockResolvedValue([]);
    const listRunningExperimentsForFlags = vi.fn().mockResolvedValue([]);
    const listRunsByIds = vi.fn().mockResolvedValue([]);
    const listSegmentsByIds = vi.fn().mockResolvedValue([]);
    const repo = {
      flags: {
        flags: { findMany },
        listFlagConfigsByFlagIds,
        listVariantsForFlags,
        listTargetingRulesByFlagIds,
        listSegmentsByIds,
      },
      experiments: { listRunningExperimentsForFlags, listRunsByIds },
    } as unknown as Repository;

    const snapshot = await buildIntegrationSnapshot(repo, envScope("app_1", "environment_1"), 9);

    expect(snapshot.flags.map((row) => row.key)).toEqual(["checkout", "search"]);
    for (const read of [
      findMany,
      listFlagConfigsByFlagIds,
      listVariantsForFlags,
      listTargetingRulesByFlagIds,
      listRunningExperimentsForFlags,
      listRunsByIds,
      listSegmentsByIds,
    ])
      expect(read).toHaveBeenCalledOnce();
  });
});

function flag(id: string, key: string) {
  return { id, key };
}

function config(row: ReturnType<typeof flag>) {
  return {
    id: `config_${row.id}`,
    flagId: row.id,
    enabled: true,
    defaultVariantId: `variant_${row.id}`,
    availableVariantNames: '["control"]',
    rollout: null,
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

function variant(flagId: string) {
  return {
    id: `variant_${flagId}`,
    flagId,
    name: "control",
    value: "false",
    description: null,
  };
}
