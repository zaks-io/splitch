export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id?: JsonRpcId;
}

interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export type JsonRpcResponse = JsonRpcErrorResponse | JsonRpcSuccessResponse;

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const request = value as Partial<JsonRpcRequest>;
  return request.jsonrpc === "2.0" && typeof request.method === "string";
}

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}
