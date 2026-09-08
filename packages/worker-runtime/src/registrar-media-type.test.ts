import { ErrorResponseSchema } from "@splitch/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createRegistrar } from "./registrar";
import { deps, okHandler, principal, route } from "./test-fixtures";

describe("registrar JSON media type", () => {
  it.each(["text/plain", "application/merge-patch+json"])(
    "rejects %s before reading, parsing, validating, or authenticating",
    async (contentType) => {
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(new TextEncoder().encode('{"name":"must not be read"}'));
        controller.close();
      });
      const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
      const validate = vi.fn();
      const auth = vi.fn(() => ({ ok: true as const, principal: principal() }));
      const handler = vi.fn(okHandler);
      const parse = vi.spyOn(JSON, "parse");
      const app = new Hono();
      createRegistrar(deps({ authResolvers: { "control-plane-token": auth } })).mount(
        app,
        route({
          auth: "control-plane-token",
          input: z.any().superRefine(validate),
        }),
        handler,
      );

      const response = await app.request(requestWithBody(body, { "content-type": contentType }));

      expect(response.status).toBe(415);
      expect(parsedRequestBodies(parse, '{"name":"must not be read"}')).toEqual([]);
      parse.mockRestore();
      expect(ErrorResponseSchema.parse(await response.json())).toMatchObject({
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "request body must use application/json",
        details: {
          receivedMediaType: contentType,
          supportedMediaTypes: ["application/json"],
        },
      });
      expect(pull).not.toHaveBeenCalled();
      expect(validate).not.toHaveBeenCalled();
      expect(auth).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("reports a missing Content-Type without reading the body", async () => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new TextEncoder().encode("{}"));
      controller.close();
    });
    const app = new Hono();
    createRegistrar(deps()).mount(app, route(), okHandler);

    const response = await app.request(
      requestWithBody(new ReadableStream({ pull }, { highWaterMark: 0 })),
    );

    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({
      code: "UNSUPPORTED_MEDIA_TYPE",
      details: {
        receivedMediaType: null,
        supportedMediaTypes: ["application/json"],
      },
    });
    expect(pull).not.toHaveBeenCalled();
  });

  it.each(["application/json", "Application/JSON; charset=utf-8"])(
    "accepts %s and preserves the bounded body path",
    async (contentType) => {
      const handler = vi.fn(okHandler);
      const app = new Hono();
      createRegistrar(deps()).mount(
        app,
        route({ input: z.object({ body: z.object({ name: z.string() }) }) }),
        handler,
      );

      const response = await app.request("/things", {
        method: "POST",
        headers: { "content-type": contentType },
        body: JSON.stringify({ name: "ok" }),
      });

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
    },
  );

  it("does not require Content-Type on a body-less mutation", async () => {
    const app = new Hono();
    createRegistrar(deps()).mount(app, route(), okHandler);

    const response = await app.request("/things", { method: "POST" });

    expect(response.status).toBe(200);
  });

  it.each(["GET", "HEAD"])("does not apply the mutation media gate to %s", async (method) => {
    const app = new Hono();
    createRegistrar(deps()).mount(app, route({ method: "GET" }), okHandler);

    const response = await app.request("/things", { method });

    expect(response.status).toBe(200);
  });
});

function requestWithBody(body: ReadableStream<Uint8Array>, headers?: HeadersInit): Request {
  return new Request("http://worker.test/things", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function parsedRequestBodies(parse: { mock: { calls: unknown[][] } }, body: string): string[] {
  return parse.mock.calls.map((call) => call[0]).filter((value): value is string => value === body);
}
