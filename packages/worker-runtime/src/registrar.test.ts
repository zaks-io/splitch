import type { ErrorResponse } from "@splitch/contracts";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createRegistrar } from "./registrar";
import {
  BodyInput,
  denyLimiter,
  deps,
  okHandler,
  principal,
  rejectingResolver,
  resolverFor,
  route,
  throwingLimiter,
} from "./test-fixtures";

async function bodyOf(res: Response): Promise<ErrorResponse> {
  return (await res.json()) as ErrorResponse;
}

describe("guard: boot-time resolver assertion", () => {
  it("throws at mount when a route's auth kind has no resolver", () => {
    const reg = createRegistrar(deps());
    const app = new Hono();
    expect(() => reg.mount(app, route({ auth: "control-plane-token" }), okHandler)).toThrow(
      /requires auth kind "control-plane-token"/,
    );
  });

  it("mounts a public route without any resolver", () => {
    const reg = createRegistrar(deps());
    const app = new Hono();
    expect(() => reg.mount(app, route({ auth: "public" }), okHandler)).not.toThrow();
  });
});

describe("guard: input validation", () => {
  it("returns VALIDATION_ERROR for a malformed body", async () => {
    const reg = createRegistrar(deps());
    const app = new Hono();
    reg.mount(app, route({ input: BodyInput }), okHandler);

    const res = await app.request("/things", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wrong: "field" }),
    });

    expect(res.status).toBe(400);
    const err = await bodyOf(res);
    expect(err.code).toBe("VALIDATION_ERROR");
    if (err.code === "VALIDATION_ERROR") {
      expect(err.details.issues.length).toBeGreaterThan(0);
    }
  });

  it("returns VALIDATION_ERROR for non-JSON body on a body route", async () => {
    const reg = createRegistrar(deps());
    const app = new Hono();
    reg.mount(app, route({ input: BodyInput }), okHandler);

    const res = await app.request("/things", {
      method: "POST",
      body: "}{not json",
    });

    expect(res.status).toBe(400);
    expect((await bodyOf(res)).code).toBe("VALIDATION_ERROR");
  });

  it("accepts a well-formed body and runs the handler", async () => {
    const reg = createRegistrar(deps());
    const app = new Hono();
    reg.mount(app, route({ input: BodyInput }), okHandler);

    const res = await app.request("/things", {
      method: "POST",
      body: JSON.stringify({ name: "ok" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("guard: authentication", () => {
  it("returns UNAUTHORIZED when the resolver rejects", async () => {
    const reg = createRegistrar(
      deps({ authResolvers: { "control-plane-token": rejectingResolver } }),
    );
    const app = new Hono();
    reg.mount(app, route({ auth: "control-plane-token" }), okHandler);

    const res = await app.request("/things", { method: "POST" });
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).code).toBe("UNAUTHORIZED");
  });
});

describe("guard: rate limiting (before scopes, fail-closed)", () => {
  it("rejects with RATE_LIMITED when the limiter denies", async () => {
    const reg = createRegistrar(deps({ rateLimiter: denyLimiter }));
    const app = new Hono();
    reg.mount(app, route({ rateLimit: "control-plane-actor" }), okHandler);

    const res = await app.request("/things", { method: "POST" });
    expect(res.status).toBe(429);
    const err = await bodyOf(res);
    expect(err.code).toBe("RATE_LIMITED");
    expect(res.headers.get("retry-after")).toBe("2");
  });

  it("fails CLOSED (RATE_LIMITED) when the limiter throws on a guarded route", async () => {
    const reg = createRegistrar(deps({ rateLimiter: throwingLimiter }));
    const app = new Hono();
    reg.mount(app, route({ rateLimit: "client-key" }), okHandler);

    const res = await app.request("/things", { method: "POST" });
    expect(res.status).toBe(429);
    expect((await bodyOf(res)).code).toBe("RATE_LIMITED");
  });

  it("never invokes the limiter for rateLimit: none", async () => {
    const reg = createRegistrar(deps({ rateLimiter: throwingLimiter }));
    const app = new Hono();
    reg.mount(app, route({ rateLimit: "none" }), okHandler);

    const res = await app.request("/things", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("throttles authenticated-but-unauthorized floods (rate-limit precedes scope)", async () => {
    const reg = createRegistrar(
      deps({
        authResolvers: { "control-plane-token": resolverFor(principal({ scopes: [] })) },
        rateLimiter: denyLimiter,
      }),
    );
    const app = new Hono();
    reg.mount(
      app,
      route({
        auth: "control-plane-token",
        rateLimit: "control-plane-actor",
        scopes: ["flags:write"],
      }),
      okHandler,
    );

    const res = await app.request("/things", { method: "POST" });
    // Rate limit must win over the scope failure.
    expect(res.status).toBe(429);
  });
});
