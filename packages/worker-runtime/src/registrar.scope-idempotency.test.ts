import {
  type ErrorResponse,
  errorCodes,
  errorStatusByCode,
  MEMBERSHIP_WIDE_READ_AUTHORIZATION,
  routeRegistry,
} from "@splitch/contracts";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createRegistrar } from "./registrar";
import { enforceScopes } from "./steps/scopes";
import { denyLimiter, deps, okHandler, principal, resolverFor, route } from "./test-fixtures";

async function bodyOf(res: Response): Promise<ErrorResponse> {
  return (await res.json()) as ErrorResponse;
}

describe("guard: membership-wide read enforcement", () => {
  it("does not let membership-wide authority satisfy a required scope", async () => {
    const wide = principal({
      authorization: MEMBERSHIP_WIDE_READ_AUTHORIZATION,
      memberships: { organizations: [], apps: [] },
    });
    const reg = createRegistrar(
      deps({ authResolvers: { "control-plane-token": resolverFor(wide) } }),
    );
    const app = new Hono();
    reg.mount(
      app,
      route({
        auth: "control-plane-token",
        method: "GET",
        path: "/apps/:appId/things",
        scopes: ["flags:read"],
      }),
      okHandler,
    );

    const res = await app.request("/apps/app_1/things");
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toMatchObject({ code: "INSUFFICIENT_SCOPES" });
  });

  it("refuses every registered control-plane mutation for membership-wide tokens", () => {
    const wide = principal({
      authorization: MEMBERSHIP_WIDE_READ_AUTHORIZATION,
      memberships: { organizations: [], apps: [] },
    });
    const mutations = routeRegistry.filter(
      (candidate) => candidate.auth === "control-plane-token" && candidate.method !== "GET",
    );

    expect(mutations.length).toBeGreaterThan(0);
    for (const mutation of mutations) {
      expect(enforceScopes(mutation, wide, {}), mutation.operationId).toMatchObject({
        code: "FORBIDDEN",
        message: "credential grants read access only",
      });
    }
  });

  it("keeps selector-bound mutations allowed when their scopes and binding match", () => {
    const selectorBound = principal({
      scopes: ["flags:write"],
      appId: "app_1",
    });
    expect(
      enforceScopes(
        route({
          auth: "control-plane-token",
          method: "POST",
          path: "/apps/:appId/things",
          scopes: ["flags:write"],
        }),
        selectorBound,
        { appId: "app_1" },
      ),
    ).toBeNull();
  });
});

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

describe("guard: authenticated input resolution", () => {
  it("enforces co-scope after substituting a resolver", async () => {
    let handledInput: unknown;
    const reg = createRegistrar(
      deps({
        authResolvers: {
          "control-plane-token": resolverFor(
            principal({ appId: null, scopes: ["app:app_1:owner"] }),
          ),
        },
        authenticatedInputResolver: ({ input, params, principal: actor }) => ({
          ok: true,
          input: { ...(input as object), params: { ...params, appId: "app_1" } },
          params: { ...params, appId: "app_1" },
          principal: { ...actor, appId: "app_1" },
        }),
      }),
    );
    const app = new Hono();
    reg.mount(
      app,
      route({ auth: "control-plane-token", method: "GET", path: "/apps/:appId/things" }),
      ({ input }) => {
        handledInput = input;
        return Response.json({ ok: true });
      },
    );

    const res = await app.request("/apps/neuron/things");

    expect(res.status).toBe(200);
    expect(handledInput).toMatchObject({ params: { appId: "app_1" } });
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

  it("rejects a 256-character key on an optional route", async () => {
    const reg = createRegistrar(deps());
    const app = new Hono();
    reg.mount(app, route({ idempotency: "optional" }), okHandler);

    const res = await app.request("/things", {
      method: "POST",
      headers: { "idempotency-key": "k".repeat(256) },
    });
    expect(res.status).toBe(400);
    const err = await bodyOf(res);
    expect(err.code).toBe("VALIDATION_ERROR");
    if (err.code !== "VALIDATION_ERROR") return;
    expect(err.details.issues).toEqual([
      {
        path: ["headers", "idempotency-key"],
        message: "Idempotency-Key header is malformed",
      },
    ]);
  });

  it("rejects a header key containing whitespace", async () => {
    const reg = createRegistrar(deps());
    const app = new Hono();
    reg.mount(app, route({ idempotency: "optional" }), okHandler);

    const res = await app.request("/things", {
      method: "POST",
      headers: { "idempotency-key": "abc 123" },
    });
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
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("stamps the baseline on success when an app omits defaultHeaders", async () => {
    const reg = createRegistrar(deps());
    const app = new Hono();
    reg.mount(app, route(), okHandler);

    const res = await app.request("/things", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("upgrades a weaker route CSP frame-ancestors and keeps other directives", async () => {
    const reg = createRegistrar(
      deps({ defaultHeaders: { "content-security-policy": "frame-ancestors 'none'" } }),
    );
    const app = new Hono();
    reg.mount(
      app,
      route(),
      () =>
        new Response("ok", {
          headers: { "content-security-policy": "default-src 'self'; frame-ancestors https:" },
        }),
    );

    const res = await app.request("/things", { method: "POST" });
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'self'; frame-ancestors 'none'",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("upgrades comma-delimited CSP policies so a later deny cannot be ignored", async () => {
    const reg = createRegistrar(
      deps({ defaultHeaders: { "content-security-policy": "frame-ancestors 'none'" } }),
    );
    const app = new Hono();
    reg.mount(
      app,
      route(),
      () =>
        new Response("ok", {
          headers: { "content-security-policy": "default-src https:, frame-ancestors https:" },
        }),
    );

    const res = await app.request("/things", { method: "POST" });
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src https:; frame-ancestors 'none', frame-ancestors 'none'",
    );
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
