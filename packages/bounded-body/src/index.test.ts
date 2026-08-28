import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasAllowedMediaType,
  mediaTypeOf,
  readBoundedRequestBody,
  trustedContentLength,
} from "./index";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mediaTypeOf", () => {
  it("strips parameters and lowercases the type", () => {
    expect(mediaTypeOf("Application/JSON; charset=UTF-8")).toBe("application/json");
    expect(mediaTypeOf("application/x-www-form-urlencoded;charset=utf-8")).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("treats a missing or empty header as absent", () => {
    expect(mediaTypeOf(null)).toBeNull();
    expect(mediaTypeOf("")).toBeNull();
    expect(mediaTypeOf("   ")).toBeNull();
  });
});

describe("hasAllowedMediaType", () => {
  it("accepts an allowed type and rejects everything else", () => {
    expect(hasAllowedMediaType("application/json; charset=utf-8", ["application/json"])).toBe(true);
    expect(hasAllowedMediaType("text/plain", ["application/json"])).toBe(false);
    expect(hasAllowedMediaType(null, ["application/json"])).toBe(false);
  });
});

describe("trustedContentLength", () => {
  it("accepts only a safe integer digit string", () => {
    expect(trustedContentLength("8")).toBe(8);
    expect(trustedContentLength("0")).toBe(0);
    expect(trustedContentLength("not-a-number")).toBeNull();
    expect(trustedContentLength("8.5")).toBeNull();
    expect(trustedContentLength("-1")).toBeNull();
    expect(trustedContentLength(null)).toBeNull();
  });
});

describe("readBoundedRequestBody", () => {
  it("rejects an unsupported content type before reading", async () => {
    const body = controlledBody(["must-not-be-read"]);
    const result = await readBoundedRequestBody(
      requestWithBody(body.stream, { "content-type": "text/plain", "content-length": "16" }),
      { maxBytes: 8, allowedMediaTypes: ["application/json"] },
    );

    expect(result).toEqual({ ok: false, reason: "unsupported_content_type" });
    expect(body.pull).not.toHaveBeenCalled();
  });

  it("rejects a declared over-limit body before reading", async () => {
    const body = controlledBody(["must-not-be-read"]);
    const result = await readBoundedRequestBody(
      requestWithBody(body.stream, {
        "content-type": "application/json",
        "content-length": "9",
      }),
      { maxBytes: 8, allowedMediaTypes: ["application/json"] },
    );

    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(body.pull).not.toHaveBeenCalled();
  });

  it("stops a chunked over-limit body at the first over-cap byte", async () => {
    const rejectedMarker = "must-never-be-read-or-logged";
    const body = controlledBody(["12345678", "9", rejectedMarker]);
    const result = await readBoundedRequestBody(
      requestWithBody(body.stream, {
        "content-type": "application/json",
        "content-length": "not-a-number",
      }),
      { maxBytes: 8, allowedMediaTypes: ["application/json"] },
    );

    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(body.pull).toHaveBeenCalledTimes(2);
    expect(body.cancel).toHaveBeenCalledTimes(1);
  });

  it("returns the exact at-limit bytes without rewriting them", async () => {
    const raw = '{"name":"ok"}';
    const result = await readBoundedRequestBody(
      new Request("http://worker.test/things", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      }),
      {
        maxBytes: new TextEncoder().encode(raw).length,
        allowedMediaTypes: ["application/json"],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(raw);
    expect(result.bytes).toEqual(new TextEncoder().encode(raw));
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
