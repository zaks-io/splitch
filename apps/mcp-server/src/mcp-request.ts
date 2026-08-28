import { DEFAULT_CONTROL_PLANE_JSON_BODY_MAX_BYTES } from "@splitch/contracts";
import { readBoundedRequestBody } from "@splitch/worker-runtime";
import {
  isJsonRpcRequest,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_PARSE_ERROR,
  type JsonRpcRequest,
  type JsonRpcResponse,
  jsonRpcError,
} from "./json-rpc";

export const MCP_JSON_RPC_MAX_BODY_BYTES = DEFAULT_CONTROL_PLANE_JSON_BODY_MAX_BYTES;

export async function readJsonRpcRequest(
  request: Request,
  maxBytes = MCP_JSON_RPC_MAX_BODY_BYTES,
): Promise<
  { ok: true; value: JsonRpcRequest } | { ok: false; status: number; response: JsonRpcResponse }
> {
  const bounded = await readBoundedRequestBody(request, {
    maxBytes,
    allowedMediaTypes: ["application/json"],
  });
  if (!bounded.ok) {
    return {
      ok: false,
      status: 400,
      response:
        bounded.reason === "too_large"
          ? jsonRpcError(null, JSON_RPC_PARSE_ERROR, "Parse error")
          : jsonRpcError(null, JSON_RPC_INVALID_REQUEST, "Invalid Request"),
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(bounded.text);
  } catch {
    return {
      ok: false,
      status: 400,
      response: jsonRpcError(null, JSON_RPC_PARSE_ERROR, "Parse error"),
    };
  }
  if (!isJsonRpcRequest(body)) {
    return {
      ok: false,
      status: 400,
      response: jsonRpcError(null, JSON_RPC_INVALID_REQUEST, "Invalid Request"),
    };
  }
  return { ok: true, value: body };
}
