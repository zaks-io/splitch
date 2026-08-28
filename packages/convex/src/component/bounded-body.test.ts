import { readBoundedRequestBody } from "@splitch/bounded-body";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONVEX_WEBHOOK_MAX_BODY_BYTES } from "./configuration-webhook";

const convexWebhookBodyOptions = {
  maxBytes: CONVEX_WEBHOOK_MAX_BODY_BYTES,
  allowedMediaTypes: ["application/json"],
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Convex webhook bounded reader", () => {
  it("rejects a declared over-limit body before reading", async () => {
    const body = controlledBody(["must-not-be-read"]);
    const result = await readBoundedRequestBody(
      requestWithBody(body.stream, {
        "content-type": "application/json",
        "content-length": String(CONVEX_WEBHOOK_MAX_BODY_BYTES + 1),
      }),
      convexWebhookBodyOptions,
    );

    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(body.pull).not.toHaveBeenCalled();
  });

  it("stops a chunked over-limit body at the first over-cap byte", async () => {
    const rejectedMarker = "must-never-be-read-or-logged";
    const body = controlledBody(["x".repeat(CONVEX_WEBHOOK_MAX_BODY_BYTES), "y", rejectedMarker]);
    const result = await readBoundedRequestBody(
      requestWithBody(body.stream, {
        "content-type": "application/json",
        "content-length": "not-a-number",
      }),
      convexWebhookBodyOptions,
    );

    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(body.pull).toHaveBeenCalledTimes(2);
    expect(body.cancel).toHaveBeenCalledTimes(1);
  });

  it("returns the exact at-limit bytes", async () => {
    const raw = `${"x".repeat(CONVEX_WEBHOOK_MAX_BODY_BYTES)}`;
    const result = await readBoundedRequestBody(
      new Request("https://convex.test/configuration", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: raw,
      }),
      convexWebhookBodyOptions,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(raw);
    expect(result.bytes.byteLength).toBe(CONVEX_WEBHOOK_MAX_BODY_BYTES);
  });

  it("rejects an unsupported content type before reading", async () => {
    const body = controlledBody(["must-not-be-read"]);
    const result = await readBoundedRequestBody(
      requestWithBody(body.stream, { "content-type": "text/plain" }),
      convexWebhookBodyOptions,
    );

    expect(result).toEqual({ ok: false, reason: "unsupported_content_type" });
    expect(body.pull).not.toHaveBeenCalled();
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
  headers: Record<string, string>,
): Request {
  return new Request("https://convex.test/configuration", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}
