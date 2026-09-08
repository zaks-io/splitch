import { MCP_DELEGATION_HEADER } from "@splitch/contracts";

export function decodeJwtHeader(token: string): Record<string, unknown> {
  const [header] = token.split(".");
  if (!header) throw new Error("missing JWT header");
  return JSON.parse(atob(decodeBase64Url(header))) as Record<string, unknown>;
}

export function decodeDelegationScopes(request: Request): string[] {
  const delegation = request.headers.get(MCP_DELEGATION_HEADER);
  if (!delegation) return [];
  const payload = delegation.split(".")[0];
  if (!payload) throw new Error("missing MCP delegation payload");
  const claims = JSON.parse(atob(decodeBase64Url(payload))) as { scopes?: unknown };
  if (!Array.isArray(claims.scopes)) throw new Error("missing MCP delegation scopes");
  return claims.scopes as string[];
}

function decodeBase64Url(value: string): string {
  return value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
}
