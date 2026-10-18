import { afterEach, beforeEach, expect, it } from "vitest";
import { ids, temporaryEnvironmentHarness } from "./temporary-environment-test-harness";

let h: Awaited<ReturnType<typeof temporaryEnvironmentHarness>>;
beforeEach(async () => {
  h = await temporaryEnvironmentHarness();
});
afterEach(async () => {
  await h.dispose();
});

it("keeps stale, expired and inventory responses byte-identical with 50 Temporary Environments", async () => {
  // Age permanent evidence so a recent Sync must not reset unchanged detection.
  await h.d1.prepare("DELETE FROM runs WHERE app_id = ?").bind(ids.appId).run();
  await h.d1.prepare("DELETE FROM targeting_rules WHERE app_id = ?").bind(ids.appId).run();
  await h.d1
    .prepare(
      "UPDATE flags SET lifecycle_class = 'release', owner = 'checkout-team', expires_at = '2026-06-01T00:00:00.000Z', updated_at = '2026-01-01T00:00:00.000Z' WHERE app_id = ?",
    )
    .bind(ids.appId)
    .run();
  await h.d1
    .prepare(
      "UPDATE flag_configs SET enabled = 0, updated_at = '2026-01-01T00:00:00.000Z' WHERE app_id = ?",
    )
    .bind(ids.appId)
    .run();
  await h.d1
    .prepare(
      "UPDATE flag_change_events SET changed_at = '2026-01-01T00:00:00.000Z' WHERE app_id = ?",
    )
    .bind(ids.appId)
    .run();
  const before = await readViews();
  expect(
    JSON.parse(before[0] ?? "").items[0].reasons.map((r: { kind: string }) => r.kind),
  ).toContain("unchanged");
  expect(JSON.parse(before[1] ?? "").items).toHaveLength(1);
  for (let index = 0; index < 50; index++) {
    const response = await h.create(`pr-${index}`, { fromEnvironmentId: "production" });
    expect(response.status).toBe(200);
    const created = await response.json();
    // Divergent scratch configuration must never enter uniform-serving evidence.
    await h.d1
      .prepare("UPDATE flag_configs SET enabled = 1, rollout = ? WHERE environment_id = ?")
      .bind(JSON.stringify({ percentage: 50, salt: "temporary-test" }), created.id)
      .run();
  }
  // An older temporary log must not extend inventory history coverage either.
  await h.d1
    .prepare(
      "UPDATE flag_change_events SET changed_at = '2025-12-01T00:00:00.000Z' WHERE temporary_environment = 1 AND seq = (SELECT min(seq) FROM flag_change_events WHERE temporary_environment = 1)",
    )
    .run();
  expect(await readViews()).toEqual(before);
  // Expired copies awaiting teardown remain excluded too.
  h.setTime("2026-07-09T20:00:00.000Z");
  const expiredBaseline = await readViews();
  expect(
    JSON.parse(expiredBaseline[0] ?? "").items[0].reasons.find(
      (r: { kind: string }) => r.kind === "uniform_serving",
    ).environments,
  ).toHaveLength(2);
  expect(h.faults).toEqual([]);
}, 30_000);

async function readViews(): Promise<string[]> {
  const views = [];
  for (const path of ["/stale-flags", "/expired-flags", "/flag-inventory-health"]) {
    const response = await h.request(path);
    expect(response.status).toBe(200);
    views.push(await response.text());
  }
  return views;
}

it("does not claim inventory history coverage from Temporary Environment logs, including after teardown", async () => {
  await h.d1.prepare("DELETE FROM flag_change_events WHERE app_id = ?").bind(ids.appId).run();
  const before = await (await h.request("/flag-inventory-health")).text();
  expect(JSON.parse(before).monthlyChurn.historyCoverageStartsAt).toBeNull();
  const response = await h.create("history-copy", { fromEnvironmentId: "production" });
  expect(response.status).toBe(200);
  const created = await response.json();
  expect(await (await h.request("/flag-inventory-health")).text()).toBe(before);
  expect((await h.request(`/envs/${created.id}`, "DELETE")).status).toBe(200);
  expect(await (await h.request("/flag-inventory-health")).text()).toBe(before);
});
