import type { McpDelegationReplayGuard } from "@splitch/contracts";
import type { McpAccessTokenActor, McpAccessTokenVerifier } from "./mcp-access-token";
import type { McpRevocationReader } from "./mcp-handler";

export const TEST_MCP_DELEGATION_SECRET = "d".repeat(32);

export function memoryMcpDelegationReplayGuard(): McpDelegationReplayGuard {
  const seen = new Set<string>();
  return {
    async claim(jti) {
      if (seen.has(jti)) return false;
      seen.add(jti);
      return true;
    },
  };
}

export function staticMcpTokenVerifier(
  actor: McpAccessTokenActor = {
    subject: "user_local_test",
    scopes: ["app:app_local:admin"],
    authDoor: "id_jag",
  },
): McpAccessTokenVerifier {
  return {
    async verify(authorization) {
      return authorization?.startsWith("Bearer ") ? actor : null;
    },
  };
}

export function allowMcpRevocations(): McpRevocationReader {
  return { isRevoked: async () => false };
}
