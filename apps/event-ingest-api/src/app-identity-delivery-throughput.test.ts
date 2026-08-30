import { afterEach, describe, expect, it, vi } from "vitest";
import { makeEntityDeliveryFixture } from "./app-identity-delivery-test-fixture";

afterEach(() => vi.unstubAllGlobals());

const BASE_ROW = {
  app_id: "app_1",
  id_type: "user",
  identity_version: "app-v1",
  server_received_at: "2026-08-07T00:00:00.000Z",
};

function deliveryFor(family: string) {
  return {
    appId: "app_1",
    idType: "user",
    identityVersion: "app-v1",
    entityFamilyHash: `app-v1:${family}`,
    datasource: "raw_events",
    row: {
      ...BASE_ROW,
      targeting_key_hash: `app-v1:${family}`,
      entity_family_hash: `app-v1:${family}`,
    },
  };
}

/**
 * The App-identity inventory is one Durable Object per App, worldwide. A mutex
 * over every request would hold that single object across the Tinybird round
 * trip, capping the App's entire ingest at one event per round trip. These
 * assert the throughput property directly: concurrent deliveries have to be in
 * flight at the same time, and a privacy reset still gets exclusive access.
 */
describe("App identity delivery throughput", () => {
  it("keeps concurrent deliveries in flight against Tinybird at the same time", async () => {
    const fixture = makeEntityDeliveryFixture();
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const append = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight -= 1;
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", append);

    const deliveries = ["family-a", "family-b", "family-c"].map((family) =>
      fixture.post("/deliver-entity-row", deliveryFor(family)),
    );
    await vi.waitFor(() => {
      expect(append).toHaveBeenCalledTimes(3);
    });
    release();

    for (const delivery of deliveries) {
      await expect(delivery).resolves.toEqual({ suppressed: false });
    }
    expect(peak, "deliveries serialized behind one another instead of overlapping").toBe(3);
  });

  it("still drains every admitted delivery before a reset purges", async () => {
    const fixture = makeEntityDeliveryFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const append = vi.fn(async () => {
      await gate;
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", append);

    const deliveries = ["family-a", "family-b"].map((family) =>
      fixture.post("/deliver-entity-row", deliveryFor(family)),
    );
    await vi.waitFor(() => {
      expect(append).toHaveBeenCalledTimes(2);
    });
    let resetSettled = false;
    const reset = fixture
      .post("/reset-app", { appId: "app_1", resetId: "reset_throughput", currentVersion: "app-v1" })
      .finally(() => {
        resetSettled = true;
      });
    // A macrotask tick, not one microtask: every storage read the reset would do
    // is an already-resolved promise, so a single flush lets it look blocked
    // even when nothing is holding it back.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resetSettled, "the reset purged while deliveries were still in flight").toBe(false);
    release();
    await Promise.all(deliveries);
    await expect(reset).resolves.toEqual({
      proof: "event-delivery:entities=2;evaluation_commits=0",
    });
    await expect(fixture.post("/deliver-entity-row", deliveryFor("family-a"))).resolves.toEqual({
      suppressed: true,
    });
  });
});
