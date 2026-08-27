import { LIST_READ_LIMIT } from "@splitch/contracts";
import type { Principal } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { makeListOrganizationsHandler } from "./org-list-handler";

const stamp = "2026-08-01T00:00:00.000Z";

function principal(overrides: Partial<Principal>): Principal {
  return {
    kind: "user",
    id: "user_1",
    scopes: [],
    orgId: null,
    appId: null,
    environmentId: null,
    authDoor: null,
    ...overrides,
  };
}

function orgRow(id: string) {
  return { id, name: id, slug: id, plan: "free" as const, createdAt: stamp, updatedAt: stamp };
}

function repo(memberships: readonly { orgId: string }[]) {
  return {
    identity: {
      listOrgMembershipsForUser: async () => [...memberships],
      getOrg: async (orgId: string) => orgRow(orgId),
    },
  };
}

async function list(
  memberships: readonly { orgId: string }[],
  actor: Principal,
): Promise<{ items: Array<{ id: string }>; readTruncated: boolean; readLimit: number }> {
  const response = await makeListOrganizationsHandler(repo(memberships) as never)({
    principal: actor,
  } as never);
  return (await response.json()) as {
    items: Array<{ id: string }>;
    readTruncated: boolean;
    readLimit: number;
  };
}

describe("organizations_list reachable-then-bound", () => {
  it("does not report truncation when every in-scope Org was returned", async () => {
    const memberships = [{ orgId: "org_a" }, { orgId: "org_b" }, { orgId: "org_scoped" }];
    const body = await list(
      memberships,
      principal({
        authDoor: "client_credentials",
        scopes: ["org:org_scoped:admin"],
      }),
    );
    expect(body.items.map((org) => org.id)).toEqual(["org_scoped"]);
    expect(body.readTruncated).toBe(false);
    expect(body.readLimit).toBe(LIST_READ_LIMIT);
  });

  it("keeps an in-scope Org that sits past the first 200 memberships", async () => {
    const memberships = [
      ...Array.from({ length: LIST_READ_LIMIT }, (_, i) => ({ orgId: `org_extra_${i}` })),
      { orgId: "org_scoped" },
    ];
    const body = await list(
      memberships,
      principal({
        authDoor: "client_credentials",
        scopes: ["org:org_scoped:member"],
      }),
    );
    expect(body.items.map((org) => org.id)).toEqual(["org_scoped"]);
    expect(body.readTruncated).toBe(false);
  });

  it("reports truncation on the reachable set for device_flow", async () => {
    const memberships = Array.from({ length: LIST_READ_LIMIT + 1 }, (_, i) => ({
      orgId: `org_${i}`,
    }));
    const body = await list(memberships, principal({ authDoor: "device_flow" }));
    expect(body.items).toHaveLength(LIST_READ_LIMIT);
    expect(body.readTruncated).toBe(true);
  });
});
