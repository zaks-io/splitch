import { PERSONAL_ACCESS_TOKEN_SECRET_PREFIX } from "@splitch/contracts";
import { verifyPersonalAccessTokenSecret } from "@splitch/worker-runtime";
import type { McpAccessTokenActor } from "./mcp-access-token";

/**
 * Personal Access Token authentication for the MCP Worker (ADR-0022,
 * 2026-10-03 amendment). The Worker has no D1, so it authenticates the secret
 * against the SESSION_STORE entry the Control Plane writes on create, rotate,
 * update, and revoke. That entry only names the owner and token id: authority
 * is never decided here. Every delegated operation carries the token id, and
 * the Control Plane re-reads the D1 row and clamps live membership by its
 * current grants, so revocation is enforced there even before KV converges.
 */

export type PersonalAccessTokenVerification =
  | { ok: true; actor: McpAccessTokenActor }
  | { ok: false; description: string };

export function looksLikePersonalAccessToken(authorization: string): boolean {
  return authorization.startsWith(`Bearer ${PERSONAL_ACCESS_TOKEN_SECRET_PREFIX}`);
}

export async function verifyPersonalAccessToken(
  store: Pick<KVNamespace, "get">,
  authorization: string,
  nowMs: number,
): Promise<PersonalAccessTokenVerification> {
  return verifyPersonalAccessTokenSecret(
    store,
    authorization.slice("Bearer ".length).trim(),
    nowMs,
  );
}
