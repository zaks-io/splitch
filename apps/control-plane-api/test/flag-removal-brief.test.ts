import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allowAllPolicies,
  appToken,
  baseFlag,
  createDefaultApp,
  createFlag,
  type FlagDefinitionHarness,
  makeFlagDefinitionHarness,
  request,
} from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

async function ownerSession() {
  const created = await createDefaultApp(h);
  return { appId: created.app.id, jwt: await appToken(h, created.app.id) };
}

describe("flag_removal_brief", () => {
  it("returns an advisory brief with SDK shapes and configuration-unverified servings", async () => {
    const { appId, jwt } = await ownerSession();
    const flag = await createFlag(h, appId, jwt, {
      ...baseFlag(appId),
      key: "new-checkout",
      name: "New Checkout",
      lifecycleClass: "release",
      owner: "checkout-team",
      expiresAt: "2026-12-31T00:00:00.000Z",
    });

    const res = await request(h, "GET", `/apps/${appId}/flags/${flag.id}/removal-brief`, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      flagKey: string;
      removalSafe: boolean;
      keepVariant: string | null;
      sdkCallShapes: string[];
      caveats: string[];
      environments: Array<{ servingEvidence: string; configurationServedVariant: string | null }>;
    };
    expect(body.flagKey).toBe("new-checkout");
    expect(body.sdkCallShapes).toContain('evaluate("new-checkout"');
    expect(body.caveats.some((c) => c.includes("never writes"))).toBe(true);
    expect(body.environments.length).toBeGreaterThan(0);
    expect(
      body.environments.every((env) => env.servingEvidence === "configuration_unverified"),
    ).toBe(true);
    // Fresh Flags start disabled on the Default Variant in every Environment.
    expect(body.removalSafe).toBe(true);
    expect(body.keepVariant).toBe("control");
  });
});

describe("flags_delete codeRemoval claim", () => {
  it("records an explicit unknown claim when codeRemoval is omitted", async () => {
    const { appId, jwt } = await ownerSession();
    await allowAllPolicies(h, appId);
    const flag = await createFlag(h, appId, jwt, {
      ...baseFlag(appId),
      key: "to-delete-unknown",
      lifecycleClass: "ops",
    });

    const deleted = await request(
      h,
      "DELETE",
      `/apps/${appId}/flags/${flag.id}`,
      jwt,
      undefined,
      "del-unknown-1",
    );
    expect(deleted.status).toBe(200);

    const changes = await request(h, "GET", `/apps/${appId}/flag-changes?flagId=${flag.id}`, jwt);
    expect(changes.status).toBe(200);
    const items = (
      (await changes.json()) as {
        items: Array<{ action: string; diff: { after: Record<string, unknown> | null } }>;
      }
    ).items;
    const deletion = items.find((item) => item.action === "deleted");
    expect(deletion?.diff.after).toMatchObject({
      codeRemoval: { state: "unknown" },
    });
  });

  it("stores a claimed codeRemoval reference on the deletion audit row", async () => {
    const { appId, jwt } = await ownerSession();
    await allowAllPolicies(h, appId);
    const flag = await createFlag(h, appId, jwt, {
      ...baseFlag(appId),
      key: "to-delete-claimed",
      lifecycleClass: "ops",
    });

    const deleted = await request(
      h,
      "DELETE",
      `/apps/${appId}/flags/${flag.id}`,
      jwt,
      { codeRemoval: { reference: "https://example.com/pr/99", state: "claimed" } },
      "del-claimed-1",
    );
    expect(deleted.status).toBe(200);

    const changes = await request(h, "GET", `/apps/${appId}/flag-changes?flagId=${flag.id}`, jwt);
    const items = (
      (await changes.json()) as {
        items: Array<{ action: string; diff: { after: Record<string, unknown> | null } }>;
      }
    ).items;
    const deletion = items.find((item) => item.action === "deleted");
    expect(deletion?.diff.after).toMatchObject({
      codeRemoval: {
        state: "claimed",
        reference: "https://example.com/pr/99",
      },
    });
  });
});
