import { appScope, createRepository, type Repository } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appToken,
  createDefaultApp,
  type FlagDefinitionHarness,
  makeAppForRepo,
  makeFlagDefinitionHarness,
  NOW_ISO,
  request,
} from "../src/flag-definition-test-harness";
import { FLAG_LIST_READ_LIMIT } from "../src/overview-thresholds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

/**
 * The Flag catalog read is bounded, reports its own bound, and costs a fixed
 * number of D1 reads whatever the page size.
 */
let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

interface FlagListBody {
  items: Array<{ id: string; key: string; variants: Array<{ name: string }> }>;
  readTruncated: boolean;
  readLimit: number;
}

/**
 * Seeds `count` Flags directly, all stamped at the SAME `created_at`.
 *
 * A shared timestamp is the interesting case, not a corner one: a seeded or
 * scripted batch writes it, and it is the only seeding under which the `id`
 * tiebreaker decides which rows the LIMIT keeps.
 */
async function seedFlags(appId: string, count: number): Promise<void> {
  const repo = createRepository(h.bindings.d1);
  const scope = appScope(appId);
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(4, "0");
    const variantId = `var_bulk_${suffix}`;
    await repo.flags.flags.insert(scope, {
      id: `flag_bulk_${suffix}`,
      appId,
      key: `bulk-flag-${suffix}`,
      name: `Bulk flag ${index}`,
      schema: JSON.stringify({ type: "boolean" }),
      defaultVariantId: variantId,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
    await repo.flags.addVariant(scope, `flag_bulk_${suffix}`, {
      id: variantId,
      name: "control",
      value: JSON.stringify(false),
      createdAt: NOW_ISO,
    });
  }
}

async function listFlags(appId: string, repo?: Repository): Promise<FlagListBody> {
  const app = repo ? makeAppForRepo(h, repo) : h.app;
  const res = await app.request(`/apps/${appId}/flags`, {
    headers: { authorization: `Bearer ${await appToken(h, appId)}` },
  });
  if (res.status !== 200) throw new Error(`list flags failed ${res.status}: ${await res.text()}`);
  return (await res.json()) as FlagListBody;
}

describe("control-plane Flag list read bound", () => {
  it("reports the catalog read as truncated instead of passing a page off as the catalog", async () => {
    const createdApp = await createDefaultApp(h);
    await seedFlags(createdApp.app.id, FLAG_LIST_READ_LIMIT + 1);

    const listed = await listFlags(createdApp.app.id);

    // The signal is the assertion. A page of exactly `readLimit` items is what a
    // complete catalog of that size also looks like, so nothing downstream can
    // recover this from `items.length` (ADR-0036).
    expect(listed.readTruncated).toBe(true);
    expect(listed.readLimit).toBe(FLAG_LIST_READ_LIMIT);
    expect(listed.items).toHaveLength(FLAG_LIST_READ_LIMIT);
  });

  it("does not claim truncation when the catalog lands exactly on the ceiling", async () => {
    const createdApp = await createDefaultApp(h);
    await seedFlags(createdApp.app.id, FLAG_LIST_READ_LIMIT);

    const listed = await listFlags(createdApp.app.id);

    // The one seeding where `>` and `>=` disagree. Both the flag and the count
    // are pinned, because a `>=` mutant returns a short page AND claims a bound.
    expect(listed.readTruncated).toBe(false);
    expect(listed.items).toHaveLength(FLAG_LIST_READ_LIMIT);
  });

  it("keeps the same head of the catalog when every Flag shares a created_at", async () => {
    const createdApp = await createDefaultApp(h);
    // 4 past the ceiling, all stamped identically, so `created_at DESC` alone
    // leaves which rows survive the LIMIT undecided.
    await seedFlags(createdApp.app.id, FLAG_LIST_READ_LIMIT + 4);

    const listed = await listFlags(createdApp.app.id);

    // THE total-order proof, and what fails if `desc(flags.id)` is dropped. Two
    // reads compared to each other would NOT catch it: SQLite is free to return
    // the same insertion-order page twice. Only a stated head does. `id` DESC
    // over fixed-width `flag_bulk_NNNN` ids counts down from the last seeded.
    const ceiling = FLAG_LIST_READ_LIMIT + 3;
    expect(listed.items.slice(0, 3).map((item) => item.key)).toEqual([
      `bulk-flag-${String(ceiling).padStart(4, "0")}`,
      `bulk-flag-${String(ceiling - 1).padStart(4, "0")}`,
      `bulk-flag-${String(ceiling - 2).padStart(4, "0")}`,
    ]);
    expect(listed.readTruncated).toBe(true);
  });

  it("resolves every Variant catalog in one read rather than one per Flag", async () => {
    const createdApp = await createDefaultApp(h);
    await seedFlags(createdApp.app.id, 25);
    const repo = createRepository(h.bindings.d1);
    const listVariants = vi.fn(repo.flags.listVariants.bind(repo.flags));
    const spied: Repository = { ...repo, flags: { ...repo.flags, listVariants } };

    const listed = await listFlags(createdApp.app.id, spied);

    // The point of the ticket: the escape hatch from an unbounded read must not
    // be an unbounded read with per-row fan-out on top.
    expect(listVariants).not.toHaveBeenCalled();
    // And the batched read still produces the same items, so the fix is not
    // "cheaper because it returns less".
    expect(listed.items).toHaveLength(25);
    expect(listed.items.every((item) => item.variants.length >= 1)).toBe(true);
  });
});
