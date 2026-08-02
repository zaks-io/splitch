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
  it("preserves the request body for signed authentication after input parsing", async () => {
    const reg = createRegistrar(
      deps({
        authResolvers: {
          "control-plane-token": async (request) => {
            expect(await request.clone().json()).toEqual({ name: "ok" });
            return { ok: true as const, principal: principal() };
          },
        },
      }),
    );
    const app = new Hono();
    reg.mount(app, route({ auth: "control-plane-token", input: BodyInput }), okHandler);

    const res = await app.request("/things", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ok" }),
    });

    expect(res.status).toBe(200);
  });

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

describe("fault path: an unexpected throw", () => {
  /**
   * The 500 body is deliberately fixed so no internal detail reaches the caller,
   * which makes the observability hop the thrown value's only route to an
   * operator. A fault reported without it is indistinguishable from every other
   * fault, so the handoff is the assertion, not an implementation detail.
   */
  it("hands the thrown value to observability while the body stays generic", async () => {
    const seen: { code: string; cause?: unknown }[] = [];
    const reg = createRegistrar(deps({ observability: { onError: (ctx) => void seen.push(ctx) } }));
    const app = new Hono();
    const boom = new Error("Network connection lost.");
    reg.mount(app, route({ auth: "public", rateLimit: "none" }), () => {
      throw boom;
    });

    const res = await app.request("/things", { method: "POST" });

    expect(res.status).toBe(500);
    const err = await bodyOf(res);
    expect(err.code).toBe("INTERNAL_SERVER_ERROR");
    // The caller learns nothing beyond "something broke".
    expect(JSON.stringify(err)).not.toContain("Network connection lost.");
    expect(seen[0]?.code).toBe("INTERNAL_SERVER_ERROR");
    expect(seen[0]?.cause).toBe(boom);
  });

  /**
   * Handing the thrown value to a sink gave the fault path a second way to fail:
   * a sink that throws would escape this catch and the caller would get Hono's
   * plain-text default, with no code and no request id. Observability is not a
   * correctness gate, so it must not be able to take the response with it.
   *
   * The two siblings below cover the other hook call sites, which are the ones a
   * fault-path-only guard leaves open: `fail()` reports from inside the same try,
   * so a throw there converts a deterministic 4xx into a 500, and `onRequest`
   * runs before the try, so a throw there escapes the guard entirely.
   */
  it("still renders the contract 500 when the observability sink throws", async () => {
    const reg = createRegistrar(
      deps({
        observability: {
          onError: () => {
            throw new Error("sink is down");
          },
        },
      }),
    );
    const app = new Hono();
    reg.mount(app, route({ auth: "public", rateLimit: "none" }), () => {
      throw new Error("original fault");
    });

    const res = await app.request("/things", { method: "POST" });

    expect(res.status).toBe(500);
    expect((await bodyOf(res)).code).toBe("INTERNAL_SERVER_ERROR");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("still renders the contract 4xx when the observability sink throws", async () => {
    const reg = createRegistrar(
      deps({
        observability: {
          onError: () => {
            throw new Error("sink is down");
          },
        },
      }),
    );
    const app = new Hono();
    reg.mount(app, route({ input: BodyInput }), okHandler);

    const res = await app.request("/things", {
      method: "POST",
      body: JSON.stringify({ wrong: "field" }),
    });

    // A broken sink downgrading a correct 400 into a 500 is worse than the lost
    // fault report it was introduced to prevent.
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).code).toBe("VALIDATION_ERROR");
  });

  it("still serves the route when the observability onRequest hook throws", async () => {
    const reg = createRegistrar(
      deps({
        observability: {
          onRequest: () => {
            throw new Error("sink is down");
          },
        },
      }),
    );
    const app = new Hono();
    reg.mount(app, route({ auth: "public", rateLimit: "none" }), okHandler);

    const res = await app.request("/things", { method: "POST" });

    // onRequest runs before the guard's try, so an unguarded throw here does not
    // even reach the fault path: Hono answers with its plain-text default and no
    // request id at all.
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});
