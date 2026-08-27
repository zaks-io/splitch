import {
  DEFAULT_MUTATING_JSON_BODY_LIMIT,
  DEFAULT_MUTATING_JSON_BODY_MAX_BYTES,
  type ErrorResponse,
} from "@splitch/contracts";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseInput } from "./parse-input";
import { createRegistrar } from "./registrar";
import { deps, principal, route } from "./test-fixtures";

const LIMIT_ERROR: ErrorResponse = {
  code: "VALIDATION_ERROR",
  message: "request body is too large",
  details: { issues: [{ path: ["body"], message: "body is too large" }] },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registrar raw-body byte limit", () => {
  it("rejects an over-cap Content-Length before reading, parsing, validating, or authenticating", async () => {
    const validate = vi.fn();
    const schema = z.any().superRefine(validate);
    const auth = vi.fn(() => ({ ok: true as const, principal: principal() }));
    const handler = vi.fn(() => Response.json({ ok: true }));
    const body = controlledBody(["this must not be read"]);
    const parse = vi.spyOn(JSON, "parse");
    const app = new Hono();
    createRegistrar(deps({ authResolvers: { "control-plane-token": auth } })).mount(
      app,
      route({
        auth: "control-plane-token",
        input: schema,
        rawBodyByteLimit: { maxBytes: 8, error: LIMIT_ERROR },
      }),
      handler,
    );

    const response = await app.request(requestWithBody(body.stream, { "content-length": "9" }));

    expect(body.pull).not.toHaveBeenCalled();
    expect(parsedRequestBodies(parse, "this must not be read")).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    parse.mockRestore();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(LIMIT_ERROR);
  });

  it("rejects an oversized body when Content-Length lies below the cap", async () => {
    const auth = vi.fn(() => ({ ok: true as const, principal: principal() }));
    const handler = vi.fn(() => Response.json({ ok: true }));
    const body = controlledBody([JSON.stringify({ value: "x".repeat(1_000) })]);
    const app = new Hono();
    createRegistrar(deps({ authResolvers: { "control-plane-token": auth } })).mount(
      app,
      route({
        auth: "control-plane-token",
        input: z.any(),
        rawBodyByteLimit: { maxBytes: 8, error: LIMIT_ERROR },
      }),
      handler,
    );

    const response = await app.request(requestWithBody(body.stream, { "content-length": "2" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(LIMIT_ERROR);
    expect(auth).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("bounds an untrusted Content-Length stream and stops at the first over-cap byte", async () => {
    const validate = vi.fn();
    const schema = z.any().superRefine(validate);
    const auth = vi.fn(() => ({ ok: true as const, principal: principal() }));
    const handler = vi.fn(() => Response.json({ ok: true }));
    const rejectedMarker = "must-never-be-read-or-logged";
    const body = controlledBody(["12345678", "9", rejectedMarker]);
    const parse = vi.spyOn(JSON, "parse");
    const errors: unknown[] = [];
    const app = new Hono();
    createRegistrar(
      deps({
        authResolvers: { "control-plane-token": auth },
        observability: { onError: (error) => errors.push(error) },
      }),
    ).mount(
      app,
      route({
        auth: "control-plane-token",
        input: schema,
        rawBodyByteLimit: { maxBytes: 8, error: LIMIT_ERROR },
      }),
      handler,
    );

    const response = await app.request(
      requestWithBody(body.stream, { "content-length": "not-a-number" }),
    );

    expect(body.pull).toHaveBeenCalledTimes(2);
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(parsedRequestBodies(parse, "12345678")).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.stringify(errors)).not.toContain(rejectedMarker);
    parse.mockRestore();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(LIMIT_ERROR);
  });

  it("parses and validates an exactly-at-cap body once, then replays its exact bytes", async () => {
    const raw = '{"name":"ok"}';
    const validate = vi.fn();
    const schema = z.object({ body: z.object({ name: z.string() }) }).superRefine(validate);
    const auth = vi.fn(async (request: Request) => {
      expect(await request.clone().text()).toBe(raw);
      return { ok: true as const, principal: principal() };
    });
    const handler = vi.fn(async ({ request }: { request: Request }) => {
      expect(await request.text()).toBe(raw);
      return Response.json({ ok: true });
    });
    const parse = vi.spyOn(JSON, "parse");
    const app = new Hono();
    createRegistrar(deps({ authResolvers: { "control-plane-token": auth } })).mount(
      app,
      route({
        auth: "control-plane-token",
        input: schema,
        rawBodyByteLimit: {
          maxBytes: new TextEncoder().encode(raw).length,
          error: LIMIT_ERROR,
        },
      }),
      handler,
    );

    const response = await app.request(
      new Request("http://worker.test/things", { method: "POST", body: raw }),
    );

    expect(parsedRequestBodies(parse, raw)).toEqual([raw]);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    parse.mockRestore();
    expect(response.status).toBe(200);
  });
});

describe("registrar default mutating JSON body limit", () => {
  it("applies the registrar default when a mutating route omits rawBodyByteLimit", async () => {
    const validate = vi.fn();
    const schema = z.any().superRefine(validate);
    const auth = vi.fn(() => ({ ok: true as const, principal: principal() }));
    const handler = vi.fn(() => Response.json({ ok: true }));
    const body = controlledBody(["this must not be read"]);
    const parse = vi.spyOn(JSON, "parse");
    const app = new Hono();
    createRegistrar(deps({ authResolvers: { "control-plane-token": auth } })).mount(
      app,
      route({
        auth: "control-plane-token",
        input: schema,
      }),
      handler,
    );

    const response = await app.request(
      requestWithBody(body.stream, {
        "content-length": String(DEFAULT_MUTATING_JSON_BODY_MAX_BYTES + 1),
      }),
    );

    expect(body.pull).not.toHaveBeenCalled();
    expect(parsedRequestBodies(parse, "this must not be read")).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    parse.mockRestore();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(DEFAULT_MUTATING_JSON_BODY_LIMIT.error);
  });

  it("stops a default-capped chunked body at the first over-cap byte", async () => {
    const validate = vi.fn();
    const schema = z.any().superRefine(validate);
    const handler = vi.fn(() => Response.json({ ok: true }));
    const rejectedMarker = "must-never-be-read-or-logged";
    const body = controlledBody([
      "x".repeat(DEFAULT_MUTATING_JSON_BODY_MAX_BYTES),
      "y",
      rejectedMarker,
    ]);
    const parse = vi.spyOn(JSON, "parse");
    const errors: unknown[] = [];
    const app = new Hono();
    createRegistrar(deps({ observability: { onError: (error) => errors.push(error) } })).mount(
      app,
      route({ input: schema }),
      handler,
    );

    const response = await app.request(
      requestWithBody(body.stream, { "content-length": "not-a-number" }),
    );

    expect(body.pull).toHaveBeenCalledTimes(2);
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(parsedRequestBodies(parse, "x")).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.stringify(errors)).not.toContain(rejectedMarker);
    parse.mockRestore();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(DEFAULT_MUTATING_JSON_BODY_LIMIT.error);
  });

  it("parses an exactly-at-default-cap body and still runs schema validation", async () => {
    const raw = atCapJson(DEFAULT_MUTATING_JSON_BODY_MAX_BYTES);
    const validate = vi.fn();
    const schema = z.object({ body: z.object({ name: z.string() }) }).superRefine(validate);
    const handler = vi.fn(() => Response.json({ ok: true }));
    const parse = vi.spyOn(JSON, "parse");
    const app = new Hono();
    createRegistrar(deps()).mount(app, route({ input: schema }), handler);

    const response = await app.request(
      new Request("http://worker.test/things", { method: "POST", body: raw }),
    );

    expect(parsedRequestBodies(parse, raw)).toEqual([raw]);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    parse.mockRestore();
    expect(response.status).toBe(200);
  });

  it("keeps a smaller explicit route limit instead of raising it to the default", async () => {
    const handler = vi.fn(() => Response.json({ ok: true }));
    const app = new Hono();
    createRegistrar(deps()).mount(
      app,
      route({
        input: z.any(),
        rawBodyByteLimit: { maxBytes: 8, error: LIMIT_ERROR },
      }),
      handler,
    );

    const response = await app.request("/things", {
      method: "POST",
      headers: { "content-length": "9" },
      body: "x".repeat(9),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(LIMIT_ERROR);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("parseInput standalone readers stay unbounded when no limit is passed", () => {
  it("still buffers a body larger than the registrar default", async () => {
    const raw = "x".repeat(DEFAULT_MUTATING_JSON_BODY_MAX_BYTES + 1);
    const parsed = await parseInput(
      z.any(),
      new Request("http://worker.test/things", { method: "POST", body: raw }),
      {},
    );

    expect(parsed.ok).toBe(true);
  });
});

function controlledBody(chunks: readonly string[]) {
  const remaining = [...chunks];
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    const chunk = remaining.shift();
    if (chunk === undefined) {
      controller.close();
      return;
    }
    controller.enqueue(new TextEncoder().encode(chunk));
  });
  const cancel = vi.fn();
  return {
    stream: new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
    pull,
    cancel,
  };
}

function requestWithBody(
  body: ReadableStream<Uint8Array>,
  headers?: Record<string, string>,
): Request {
  return new Request("http://worker.test/things", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function parsedRequestBodies(parse: { mock: { calls: unknown[][] } }, prefix: string): string[] {
  return parse.mock.calls
    .map((call) => call[0])
    .filter((value): value is string => typeof value === "string" && value.startsWith(prefix));
}

function atCapJson(maxBytes: number): string {
  const prefix = '{"name":"';
  const suffix = '"}';
  const pad = maxBytes - prefix.length - suffix.length;
  if (pad < 0) {
    throw new Error(`maxBytes ${maxBytes} is too small for an at-cap JSON object`);
  }
  return `${prefix}${"a".repeat(pad)}${suffix}`;
}
