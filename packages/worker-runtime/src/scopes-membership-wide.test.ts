import { MEMBERSHIP_WIDE_READ_AUTHORIZATION } from "@splitch/contracts";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createRegistrar } from "./registrar";
import { deps, okHandler, principal, resolverFor, route } from "./test-fixtures";

describe("membership-wide scope enforcement", () => {
  it("allows a live Organization and refuses a foreign Organization", async () => {
    const wide = principal({
      authorization: MEMBERSHIP_WIDE_READ_AUTHORIZATION,
      memberships: {
        organizations: [{ id: "org_own", role: "member" }],
        apps: [],
      },
    });
    const app = mounted(wide);

    expect((await app.request("/orgs/org_own/things")).status).toBe(200);
    expect((await app.request("/orgs/org_foreign/things")).status).toBe(403);
  });

  it("fails loud when the resolver omits live memberships", async () => {
    const app = mounted(
      principal({ authorization: MEMBERSHIP_WIDE_READ_AUTHORIZATION, memberships: undefined }),
    );

    const res = await app.request("/orgs/org_own/things");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
});

function mounted(actor: ReturnType<typeof principal>): Hono {
  const registrar = createRegistrar(
    deps({ authResolvers: { "control-plane-token": resolverFor(actor) } }),
  );
  const app = new Hono();
  registrar.mount(
    app,
    route({
      auth: "control-plane-token",
      method: "GET",
      path: "/orgs/:orgId/things",
      scopes: [],
    }),
    okHandler,
  );
  return app;
}
