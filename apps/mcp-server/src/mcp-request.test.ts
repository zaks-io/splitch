import { afterEach, describe, expect, it, vi } from "vitest";
import { JSON_RPC_INVALID_REQUEST, JSON_RPC_PARSE_ERROR } from "./json-rpc";
import { MCP_JSON_RPC_MAX_BODY_BYTES, readJsonRpcRequest } from "./mcp-request";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP JSON-RPC body bound", () => {
  it("rejects a declared over-limit body before JSON parse", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const body = controlledBody(["must-not-be-read"]);

    const result = await readJsonRpcRequest(
      requestWithBody(body.stream, {
        "content-type": "application/json",
        "content-length": String(MCP_JSON_RPC_MAX_BODY_BYTES + 1),
      }),
    );

    expect(body.pull).not.toHaveBeenCalled();
    expect(parsedRequestBodies(parse, "must-not")).toEqual([]);
    parse.mockRestore();
    expect(result).toEqual({
      ok: false,
      status: 400,
      response: {
        jsonrpc: "2.0",
        id: null,
        error: { code: JSON_RPC_PARSE_ERROR, message: "Parse error" },
      },
    });
  });

  it("stops a chunked over-limit body at the first over-cap byte", async () => {
    const rejectedMarker = "must-never-be-read-or-logged";
    const parse = vi.spyOn(JSON, "parse");
    const body = controlledBody(["12345678", "9", rejectedMarker]);

    const result = await readJsonRpcRequest(
      requestWithBody(body.stream, {
        "content-type": "application/json",
        "content-length": "not-a-number",
      }),
      8,
    );

    expect(body.pull).toHaveBeenCalledTimes(2);
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(parsedRequestBodies(parse, "12345678")).toEqual([]);
    parse.mockRestore();
    expect(result).toEqual({
      ok: false,
      status: 400,
      response: {
        jsonrpc: "2.0",
        id: null,
        error: { code: JSON_RPC_PARSE_ERROR, message: "Parse error" },
      },
    });
  });

  it("accepts an at-limit JSON-RPC request", async () => {
    const raw = atCapJsonRpc(128);

    const result = await readJsonRpcRequest(
      new Request("https://mcp.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: raw,
      }),
      new TextEncoder().encode(raw).length,
    );

    expect(result).toEqual({
      ok: true,
      value: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
  });

  it("rejects an unsupported content type before JSON parse", async () => {
    const parse = vi.spyOn(JSON, "parse");

    const result = await readJsonRpcRequest(
      new Request("https://mcp.test/mcp", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      }),
    );

    expect(parsedRequestBodies(parse, '{"jsonrpc"')).toEqual([]);
    parse.mockRestore();
    expect(result).toEqual({
      ok: false,
      status: 400,
      response: {
        jsonrpc: "2.0",
        id: null,
        error: { code: JSON_RPC_INVALID_REQUEST, message: "Invalid Request" },
      },
    });
  });

  it("keeps malformed under-cap JSON on the parse-error path", async () => {
    const result = await readJsonRpcRequest(
      new Request("https://mcp.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "}{",
      }),
    );

    expect(result).toEqual({
      ok: false,
      status: 400,
      response: {
        jsonrpc: "2.0",
        id: null,
        error: { code: JSON_RPC_PARSE_ERROR, message: "Parse error" },
      },
    });
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
  return new Request("https://mcp.test/mcp", {
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

function atCapJsonRpc(maxBytes: number): string {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const pad = maxBytes - new TextEncoder().encode(body).length;
  if (pad < 0) throw new Error("fixture exceeds target byte length");
  return `${body}${" ".repeat(pad)}`;
}
