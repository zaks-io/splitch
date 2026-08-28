import { afterEach, describe, expect, it, vi } from "vitest";
import { EVENT_INGEST_MAX_BODY_BYTES, readJsonObject } from "./payload";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("internal ingest JSON body bound", () => {
  it("rejects a declared over-limit body before JSON parse", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const body = controlledBody(["must-not-be-read"]);

    const result = await readJsonObject(
      requestWithBody(body.stream, {
        "content-type": "application/json",
        "content-length": String(EVENT_INGEST_MAX_BODY_BYTES + 1),
      }),
    );

    expect(body.pull).not.toHaveBeenCalled();
    expect(parsedRequestBodies(parse, "must-not")).toEqual([]);
    parse.mockRestore();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "request body is too large",
    });
  });

  it("stops a chunked over-limit body at the first over-cap byte", async () => {
    const rejectedMarker = "must-never-be-read-or-logged";
    const parse = vi.spyOn(JSON, "parse");
    const body = controlledBody(["x".repeat(EVENT_INGEST_MAX_BODY_BYTES), "y", rejectedMarker]);

    const result = await readJsonObject(
      requestWithBody(body.stream, {
        "content-type": "application/json",
        "content-length": "not-a-number",
      }),
    );

    expect(body.pull).toHaveBeenCalledTimes(2);
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(parsedRequestBodies(parse, "x".repeat(64))).toEqual([]);
    parse.mockRestore();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("request body is too large");
  });

  it("accepts an at-limit JSON object", async () => {
    const raw = atCapJson(EVENT_INGEST_MAX_BODY_BYTES);

    const result = await readJsonObject(
      new Request("https://ingest.test/api/internal/exposures", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: raw,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.eventId).toBe("evt_1");
  });

  it("rejects an unsupported content type before JSON parse", async () => {
    const parse = vi.spyOn(JSON, "parse");

    const result = await readJsonObject(
      new Request("https://ingest.test/api/internal/exposures", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: '{"eventId":"evt_1"}',
      }),
    );

    expect(parsedRequestBodies(parse, '{"eventId"')).toEqual([]);
    parse.mockRestore();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("request body must be application/json");
  });

  it("keeps malformed under-cap JSON on the existing validation path", async () => {
    const result = await readJsonObject(
      new Request("https://ingest.test/api/internal/exposures", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "}{",
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("request body must be valid JSON");
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
  return new Request("https://ingest.test/api/internal/exposures", {
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
  const body = JSON.stringify({ eventId: "evt_1", pad: "" });
  const pad = maxBytes - new TextEncoder().encode(body).length;
  if (pad < 0) throw new Error("fixture exceeds target byte length");
  return JSON.stringify({ eventId: "evt_1", pad: "a".repeat(pad) });
}
