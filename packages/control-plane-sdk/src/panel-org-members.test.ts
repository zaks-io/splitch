import { boundListRead } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import { createPanelOrgMembersClient } from "./panel-org-members";

describe("panel Org membership binding transport", () => {
  it("round-trips list, add, update, and remove with typed bodies", async () => {
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        method: request.method,
        url: request.url,
        body: await request.clone().text(),
      });
      if (request.method === "DELETE") return Response.json({ deleted: true });
      if (request.method === "GET") return Response.json(boundListRead([member()]));
      return Response.json({ ...member(), ...((await request.json()) as object) });
    });
    const client = createPanelOrgMembersClient({ fetch: fetcher });

    await expect(client.list({ orgId: "org_1" })).resolves.toMatchObject({
      ok: true,
      data: { items: [{ id: "user_1", role: "owner" }] },
    });
    await expect(
      client.add({ orgId: "org_1", userId: "user_2", role: "admin" }),
    ).resolves.toMatchObject({ ok: true, data: { role: "admin" } });
    await expect(
      client.update({ orgId: "org_1", userId: "user_1", role: "member" }),
    ).resolves.toMatchObject({ ok: true, data: { role: "member" } });
    await expect(client.remove({ orgId: "org_1", userId: "user_1" })).resolves.toMatchObject({
      ok: true,
      data: { deleted: true },
    });

    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "https://control-plane.internal/orgs/org_1/members"],
      ["POST", "https://control-plane.internal/orgs/org_1/members"],
      ["PATCH", "https://control-plane.internal/orgs/org_1/members/user_1"],
      ["DELETE", "https://control-plane.internal/orgs/org_1/members/user_1"],
    ]);
    // The add body carries the member and the role only: `orgId` travels in the
    // path, and a stray field would change the delegation's body digest.
    expect(JSON.parse(requests[1]?.body ?? "{}")).toEqual({ userId: "user_2", role: "admin" });
    expect(JSON.parse(requests[2]?.body ?? "{}")).toEqual({ role: "member" });
  });

  it("surfaces a Worker refusal as a typed failure rather than throwing", async () => {
    const client = createPanelOrgMembersClient({
      fetch: vi.fn(async () =>
        Response.json(
          {
            code: "LAST_OWNER_REQUIRED",
            message: "organization must retain at least one owner",
            details: { orgId: "org_1" },
          },
          { status: 409 },
        ),
      ),
    });

    await expect(client.remove({ orgId: "org_1", userId: "user_1" })).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "LAST_OWNER_REQUIRED" },
    });
  });

  it("preserves a membership whose profile email is not cached yet", async () => {
    const client = createPanelOrgMembersClient({
      fetch: vi.fn(async () => Response.json(boundListRead([{ ...member(), email: null }]))),
    });

    await expect(client.list({ orgId: "org_1" })).resolves.toMatchObject({
      ok: true,
      data: { items: [{ id: "user_1", email: null, role: "owner" }] },
    });
  });

  it("rejects invalid successful response bodies", async () => {
    const client = createPanelOrgMembersClient({
      fetch: vi.fn(async () => Response.json(boundListRead([{ id: "user_1", role: "superuser" }]))),
    });

    await expect(client.list({ orgId: "org_1" })).rejects.toThrow(
      "organization_members_list returned an invalid response body",
    );
  });

  it("preserves an absent profile on roster reads", async () => {
    const client = createPanelOrgMembersClient({
      fetch: vi.fn(async () => Response.json(boundListRead([{ ...member(), email: null }]))),
    });

    await expect(client.list({ orgId: "org_1" })).resolves.toMatchObject({
      ok: true,
      data: { items: [{ id: "user_1", email: null, role: "owner" }] },
    });
  });

  it("preserves an absent profile on role updates", async () => {
    const client = createPanelOrgMembersClient({
      fetch: vi.fn(async () => Response.json({ ...member(), email: null, role: "admin" })),
    });

    await expect(
      client.update({ orgId: "org_1", userId: "user_1", role: "admin" }),
    ).resolves.toMatchObject({
      ok: true,
      data: { id: "user_1", email: null, role: "admin" },
    });
  });

  it("preserves an absent profile when adding a member", async () => {
    const client = createPanelOrgMembersClient({
      fetch: vi.fn(async () => Response.json({ ...member(), email: null, role: "member" })),
    });

    await expect(
      client.add({ orgId: "org_1", userId: "user_1", role: "member" }),
    ).resolves.toMatchObject({
      ok: true,
      data: { id: "user_1", email: null, role: "member" },
    });
  });
});

function member() {
  return {
    id: "user_1",
    email: "owner@acme.test",
    organizationId: "org_1",
    role: "owner",
    createdAt: "2026-08-07T00:00:00.000Z",
  };
}
