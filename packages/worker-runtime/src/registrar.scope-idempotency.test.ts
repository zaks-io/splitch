import { errorCodes, errorStatusByCode, type ErrorResponse } from "@splitch/contracts";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createRegistrar } from "./registrar.js";
import { denyLimiter, deps, okHandler, principal, resolverFor, route } from "./test-fixtures.js";

async function bodyOf(res: Response): Promise<ErrorResponse> {
  return (await res.json()) as ErrorResponse;
}

describe("guard: scope + co-scope enforcement", () => {
  it("returns INSUFFICIENT_SCOPES with required vs held", async () => {
    const reg = createRegistrar(
      deps({
        authResolvers: {
          "control-plane-token": resolverFor(principal({ scopes: ["flags:read"] })),
        },
      }),
    );
    const app = new Hono();
    reg.mount(app, route({ auth: "control-plane-token", scopes: ["flags:write"] }), okHandler);

    const res = await app.request("/things", { method: "POST" });
    expect(res.status).toBe(403);
    const err = await bodyOf(res);
    expect(err.code).toBe("INSUFFICIENT_SCOPES");
    if (err.code === "INSUFFICIENT_SCOPES") {
      expect(err.details.requiredScopes).toEqual(["flags:write"]);
      expect(err.details.heldScopes).toEqual(["flags:read"]);
    }
  });

  it("returns FORBIDDEN on app co-scope mismatch", async () => {
    const reg = createRegistrar(
      deps({
        authResolvers: { "control-plane-token": resolverFor(principal({ appId: "app_other" })) },
      }),
    );
    const app = new Hono();
    reg.mount(
      app,
      route({ auth: "control-plane-token", method: "GET", path: "/apps/:appId/things" }),
      okHandler,
    );

    const res = await app.request("/apps/app_1/things");
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).code).toBe("FORBIDDEN");
  });

  it("returns FORBIDDEN when the principal is bound to no app (appId null) on an app-scoped route", async () => {
    const reg = createRegistrar(
      deps({
        authResolvers: { "control-plane-token": resolverFor(principal({ appId: null })) },
      }),
    );
    const app = new Hono();
    reg.mount(
      app,
      route({ auth: "control-plane-token", method: "GET", path: "/apps/:appId/things" }),
      okHandler,
    );

    const res = await app.request("/apps/app_1/things");
    // An org-level (app-unbound) token must not reach an app-scoped resource.
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).code).toBe("FORBIDDEN");
  });

  it("allows when app co-scope matches", async () => {
    const reg = createRegistrar(
      deps({
        authResolvers: { "control-plane-token": resolverFor(principal({ appId: "app_1" })) },
      }),
    );
    const app = new Hono();
    reg.mount(
      app,
      route({ auth: "control-plane-token", method: "GET", path: "/apps/:appId/things" }),
      okHandler,
    );

    const res = await app.request("/apps/app_1/things");
    expect(res.status).toBe(200);
  });

  it("returns FORBIDDEN on org co-scope mismatch", async () => {
    const reg = createRegistrar(
      deps({
        authResolvers: { "control-plane-token": resolverFor(principal({ orgId: "org_a" })) },
      }),
    );
    const app = new Hono();
    reg.mount(
      app,
      route({ auth: "control-plane-token", method: "GET", path: "/orgs/:orgId" }),
      okHandler,
    );

    // A token bound to org_a must not read org_b by path.
    const res = await app.request("/orgs/org_b");
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).code).toBe("FORBIDDEN");
  });

  it("returns FORBIDDEN when the principal is bound to no org (orgId null) on an org-scoped route", async () => {
    const reg = createRegistrar(
      deps({
        authResolvers: { "control-plane-token": resolverFor(principal({ orgId: null })) },
      }),
    );
    const app = new Hono();
    reg.mount(
      app,
      route({ auth: "control-plane-token", method: "GET", path: "/orgs/:orgId" }),
      okHandler,
    );

    // An org-unbound token must not reach an org-scoped resource.
    const res = await app.request("/orgs/org_b");
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).code).toBe("FORBIDDEN");
  });

  it("allows when org co-scope matches", async () => {
    const reg = createRegistrar(
      deps({
        authResolvers: { "control-plane-token": resolverFor(principal({ orgId: "org_a" })) },
      }),
    );
    const app = new Hono();
    reg.mount(
      app,
      route({ auth: "control-plane-token", method: "GET", path: "/orgs/:orgId" }),
      okHandler,
    );

    const res = await app.request("/orgs/org_a");
    expect(res.status).toBe(200);
  });
});

describe("guard: idempotency header validation", () => {
  it("rejects a required idempotency route with no key", async () => {
    const reg = createRegistrar(deps());
    const app = new Hono();
    reg.mount(app, route({ idempotency: "required" }), okHandler);

    const res = await app.request("/things", { method: "POST" });
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).code).toBe("VALIDATION_ERROR");
  });

  it("accepts a required idempotency route with a valid key", async () => {
    const reg = createRegistrar(deps());
    const app = new Hono();
    reg.mount(app, route({ idempotency: "required" }), okHandler);

    const res = await app.request("/things", {
      method: "POST",
      headers: { "idempotency-key": "abc-123" },
    });
    expect(res.status).toBe(200);
  });

  it("ignores a stray key on a none route", async () => {
    const reg = createRegistrar(deps());
    const app = new Hono();
    reg.mount(app, route({ idempotency: "none" }), okHandler);

    const res = await app.request("/things", {
      method: "POST",
      headers: { "idempotency-key": "whatever" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a present-but-empty key on an optional route", async () => {
    const reg = createRegistrar(deps());
    const app = new Hono();
    reg.mount(app, route({ idempotency: "optional" }), okHandler);

    const res = await app.request("/things", {
      method: "POST",
      headers: { "idempotency-key": "" },
    });
    // A present header that is empty is malformed, even on an optional route.
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).code).toBe("VALIDATION_ERROR");
  });

  it("allows an absent key on an optional route", async () => {
    const reg = createRegistrar(deps());
    const app = new Hono();
    reg.mount(app, route({ idempotency: "optional" }), okHandler);

    const res = await app.request("/things", { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("guard: fault path + response decoration", () => {
  it("renders INTERNAL_SERVER_ERROR when the handler throws", async () => {
    const reg = createRegistrar(deps());
    const app = new Hono();
    reg.mount(app, route(), () => {
      throw new Error("boom");
    });

    const res = await app.request("/things", { method: "POST" });
    expect(res.status).toBe(500);
    expect((await bodyOf(res)).code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("stamps x-request-id on success and echoes the incoming one", async () => {
    const reg = createRegistrar(deps());
    const app = new Hono();
    reg.mount(app, route(), okHandler);

    const res = await app.request("/things", {
      method: "POST",
      headers: { "x-request-id": "req-xyz" },
    });
    expect(res.headers.get("x-request-id")).toBe("req-xyz");
  });

  it("merges default headers onto rendered errors", async () => {
    const reg = createRegistrar(
      deps({ rateLimiter: denyLimiter, defaultHeaders: { "x-splitch": "on" } }),
    );
    const app = new Hono();
    reg.mount(app, route({ rateLimit: "api-key" }), okHandler);

    const res = await app.request("/things", { method: "POST" });
    expect(res.headers.get("x-splitch")).toBe("on");
  });
});

describe("contract status map is the single source of HTTP status", () => {
  it("maps every code to exactly one status", () => {
    for (const code of errorCodes) {
      expect(errorStatusByCode[code]).toBeGreaterThanOrEqual(400);
      expect(errorStatusByCode[code]).toBeLessThan(600);
    }
  });
});
