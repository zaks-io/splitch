import { beforeAll, describe, expect, it } from "vitest";
import type { SignedControlPanelEntrypoint } from "../src/index.js";
import {
  panelEntrypoint,
  panelFlagsIds,
  panelTestEnv,
  seedPanelFlags,
  signedPanelRequest,
} from "./panel-flags-harness.js";

/**
 * Drives the panel's Variant editor output through the authoritative Worker
 * handler over signed delegation: the same path the browser exercises.
 */
const ids = panelFlagsIds("catalog");
const APP_ID = ids.appId;

let entrypoint: SignedControlPanelEntrypoint;

beforeAll(async () => {
  await seedPanelFlags(ids);
  entrypoint = panelEntrypoint(panelTestEnv());
});

async function createFlag(body: unknown): Promise<Response> {
  return entrypoint.fetch(await signedPanelRequest(ids, "POST", `/apps/${APP_ID}/flags`, body));
}

describe("Create Flag Variant catalog", () => {
  it("creates a three-Variant string catalog authored in the panel's Variant editor", async () => {
    const response = await createFlag({
      appId: APP_ID,
      idempotency_key: "idem-panel-variant-catalog",
      key: "checkout-copy",
      name: "Checkout Copy",
      schema: { type: "string" },
      variants: [
        { name: "control", value: "Buy now", isDefault: true },
        { name: "urgent", value: "Buy now, limited stock", description: "scarcity copy" },
        { name: "calm", value: "Add to cart" },
      ].map((variant) => ({ isDefault: false, ...variant })),
    });

    expect(response.status).toBe(200);
    const created = (await response.json()) as {
      variants: Array<{ id: string; name: string; value: unknown }>;
      defaultVariantId: string;
    };
    expect(created.variants.map((variant) => [variant.name, variant.value])).toEqual([
      ["control", "Buy now"],
      ["urgent", "Buy now, limited stock"],
      ["calm", "Add to cart"],
    ]);
    // The Default the editor marked is the Variant the Worker minted an id for.
    expect(created.defaultVariantId).toBe(
      created.variants.find((variant) => variant.name === "control")?.id,
    );
  });

  /**
   * The editor enforces one value type per Flag; emitting that type as the Flag
   * `schema` makes the Worker enforce it too, so a mixed catalog fails loudly
   * rather than persisting (ADR-0036).
   */
  it("refuses a catalog whose values contradict the declared value type", async () => {
    const response = await createFlag({
      appId: APP_ID,
      key: "checkout-mixed",
      name: "Checkout Mixed",
      schema: { type: "string" },
      variants: [
        { name: "control", value: "Buy now", isDefault: true },
        { name: "broken", value: 42, isDefault: false },
      ],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
