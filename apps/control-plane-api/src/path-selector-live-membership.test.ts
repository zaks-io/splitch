import { env } from "cloudflare:workers";
import { createRepository } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { resetOrganizationGraph, seedAppMember, seedOrgApp, seedOrgMember } from "./test-seeds";

const USER = "user_live_mcp_selector";

beforeEach(() => resetOrganizationGraph(env.DB));

describe("live MCP Organization binding", () => {
  it("selects one addressed Organization from multiple memberships", async () => {
    await seedOrganization("a");
    await seedOrganization("b");
    await seedOrganization("c");
    const actor: Principal = {
      kind: "control-plane-token",
      id: USER,
      scopes: ["org:org_live_a:owner", "org:org_live_b:owner"],
      orgId: null,
      appId: null,
      environmentId: null,
      authDoor: "device_flow",
      liveMembership: true,
    };
    const app = createApp({
      authResolver: async () => ({ ok: true, principal: actor }),
      rateLimiter: () => ({ limited: false }),
      repo: createRepository(env.DB),
    });

    const selected = await app.request("/orgs/org_live_b");
    const unrelated = await app.request("/orgs/org_live_c");

    expect(selected.status).toBe(200);
    await expect(selected.json()).resolves.toMatchObject({ id: "org_live_b" });
    expect(unrelated.status).toBe(403);
  });
});

async function seedOrganization(suffix: string): Promise<void> {
  const orgId = `org_live_${suffix}`;
  const appId = `app_live_${suffix}`;
  await seedOrgApp(env.DB, {
    orgId,
    orgName: suffix,
    orgSlug: `live-${suffix}`,
    appId,
    appName: suffix,
    appKey: `live-${suffix}`,
  });
  await seedOrgMember(env.DB, { orgId, userId: USER, role: "owner" });
  await seedAppMember(env.DB, { appId, userId: USER, role: "owner" });
}
