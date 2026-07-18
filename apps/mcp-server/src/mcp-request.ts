import {
  isJsonRpcRequest,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_PARSE_ERROR,
  type JsonRpcRequest,
  type JsonRpcResponse,
  jsonRpcError,
} from "./json-rpc";

export async function readJsonRpcRequest(
  request: Request,
): Promise<
  { ok: true; value: JsonRpcRequest } | { ok: false; status: number; response: JsonRpcResponse }
> {
  let body: unknown;
  try {
    body = await request.json();
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
