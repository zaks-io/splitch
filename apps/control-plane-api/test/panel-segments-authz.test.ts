import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import type { SignedControlPanelEntrypoint } from "../src/index.js";
import {
  isolatedPanelTenant,
  isolatedTenantAsPanelIds,
  panelEntrypoint,
  panelFlagsIds,
  panelTestEnv,
  seedAppMembership,
  seedIsolatedPanelTenant,
  seedPanelFlags,
  signedPanelRequest,
} from "./panel-flags-harness.js";

const ids = panelFlagsIds("seg_authz");
const memberUserId = `user_panel_flags_member_${ids.suffix}`;
let testEnv: ControlPlaneApiEnv;
let entrypoint: SignedControlPanelEntrypoint;

beforeAll(async () => {
  await seedPanelFlags(ids);
  await env.DB.prepare(
    "INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)",
  )
    .bind(ids.orgId, memberUserId, "member", "2026-07-19T00:00:00.000Z")
    .run();
  await seedAppMembership(ids, "member", memberUserId);
  testEnv = panelTestEnv();
  entrypoint = panelEntrypoint(testEnv);
});

describe("SignedControlPanelEntrypoint Segment authorization boundaries", () => {
  it("refuses Segment create, update, and delete for an App member", async () => {
    const owned = await ownerCreate({
      name: "Member gate target",
      conditions: [{ attribute: "plan", operator: "eq", value: "member-gate" }],
    });

    const create = await memberRequest("POST", `/apps/${ids.appId}/segments`, {
      name: "Member create",
      conditions: [{ attribute: "plan", operator: "eq", value: "nope" }],
    });
    expect(create.status).toBe(403);
    expect(await create.json()).toMatchObject({ code: "INSUFFICIENT_SCOPES" });

    const update = await memberRequest("PATCH", `/apps/${ids.appId}/segments/${owned.id}`, {
      name: "Member rename",
    });
    expect(update.status).toBe(403);
    expect(await update.json()).toMatchObject({ code: "INSUFFICIENT_SCOPES" });

    const deleted = await memberRequest("DELETE", `/apps/${ids.appId}/segments/${owned.id}`);
    expect(deleted.status).toBe(403);
    expect(await deleted.json()).toMatchObject({ code: "INSUFFICIENT_SCOPES" });

    const stillThere = await ownerRequest("GET", `/apps/${ids.appId}/segments/${owned.id}`);
    expect(stillThere.status).toBe(200);
    expect(await stillThere.json()).toMatchObject({ id: owned.id, name: "Member gate target" });
  });

  it("never returns or mutates a foreign App's Segment addressed by id", async () => {
    const attacker = isolatedPanelTenant("seg_xapp", "alpha");
    const victim = isolatedPanelTenant("seg_xapp", "bravo");
    await seedIsolatedPanelTenant(attacker, "owner");
    await seedIsolatedPanelTenant(victim, "owner");

    const attackerIds = isolatedTenantAsPanelIds(attacker);
    const victimIds = isolatedTenantAsPanelIds(victim);
    const victimSegment = await createAs(victimIds, {
      name: "Victim cohort",
      conditions: [{ attribute: "secret", operator: "eq", value: "bravo-only" }],
    });

    const read = await entrypoint.fetch(
      await signedPanelRequest(
        attackerIds,
        "GET",
        `/apps/${attacker.appId}/segments/${victimSegment.id}`,
      ),
    );
    expect(read.status).toBe(404);
    const readBody = await read.text();
    expect(readBody).not.toContain("bravo-only");
    expect(readBody).not.toContain("Victim cohort");

    const update = await entrypoint.fetch(
      await signedPanelRequest(
        attackerIds,
        "PATCH",
        `/apps/${attacker.appId}/segments/${victimSegment.id}`,
        { name: "Exfiltrated", conditions: [{ attribute: "x", operator: "eq", value: "stolen" }] },
      ),
    );
    expect(update.status).toBe(404);

    const deleted = await entrypoint.fetch(
      await signedPanelRequest(
        attackerIds,
        "DELETE",
        `/apps/${attacker.appId}/segments/${victimSegment.id}`,
      ),
    );
    expect(deleted.status).toBe(404);

    const intact = await entrypoint.fetch(
      await signedPanelRequest(
        victimIds,
        "GET",
        `/apps/${victim.appId}/segments/${victimSegment.id}`,
      ),
    );
    expect(intact.status).toBe(200);
    expect(await intact.json()).toMatchObject({
      id: victimSegment.id,
      name: "Victim cohort",
      appId: victim.appId,
    });

    const foreignAppPath = await entrypoint.fetch(
      await signedPanelRequest(
        attackerIds,
        "GET",
        `/apps/${victim.appId}/segments/${victimSegment.id}`,
      ),
    );
    expect(foreignAppPath.status).toBe(403);
  });
});

async function ownerCreate(body: {
  name: string;
  conditions: Array<{ attribute: string; operator: "eq"; value: string }>;
}) {
  const response = await ownerRequest("POST", `/apps/${ids.appId}/segments`, body);
  if (!response.ok) throw new Error(`owner create failed: ${await response.text()}`);
  return (await response.json()) as { id: string; name: string };
}

async function createAs(
  tenantIds: ReturnType<typeof isolatedTenantAsPanelIds>,
  body: {
    name: string;
    conditions: Array<{ attribute: string; operator: "eq"; value: string }>;
  },
) {
  const response = await entrypoint.fetch(
    await signedPanelRequest(tenantIds, "POST", `/apps/${tenantIds.appId}/segments`, body),
  );
  if (!response.ok) throw new Error(`tenant create failed: ${await response.text()}`);
  return (await response.json()) as { id: string; name: string };
}

function ownerRequest(method: string, path: string, body?: unknown): Promise<Response> {
  return signedPanelRequest(ids, method, path, body).then((request) => entrypoint.fetch(request));
}

function memberRequest(method: string, path: string, body?: unknown): Promise<Response> {
  return signedPanelRequest(ids, method, path, body, undefined, memberUserId).then((request) =>
    entrypoint.fetch(request),
  );
}
