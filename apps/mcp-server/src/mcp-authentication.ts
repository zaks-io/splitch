import { noopPerformanceSpanRecorder } from "@splitch/observability/performance-spans";
import type { McpAccessTokenActor, McpAccessTokenVerifier } from "./mcp-access-token";
import type { McpServerRequestOptions } from "./mcp-handler";
import {
  looksLikePersonalAccessToken,
  verifyPersonalAccessToken,
} from "./mcp-personal-access-token";

export async function authenticateMcpBearer(
  options: McpServerRequestOptions,
  verifier: McpAccessTokenVerifier,
  authorization: string,
  audience: string,
): Promise<McpAccessTokenActor | null | { refused: string }> {
  const spans = options.performanceSpans ?? noopPerformanceSpanRecorder;
  return spans.record({ name: "mcp.auth.bearer.verify", op: "auth" }, async () => {
    const nowMs = options.now?.() ?? Date.now();
    if (looksLikePersonalAccessToken(authorization)) {
      // PAT revocation belongs to the PAT itself, not the CLI session marker.
      const verified = await spans.record({ name: "mcp.auth.pat.verify", op: "auth" }, async () => {
        if (!options.personalAccessTokens) {
          throw new Error("mcp-server: SESSION_STORE personal access token binding is required");
        }
        return verifyPersonalAccessToken(options.personalAccessTokens, authorization, nowMs);
      });
      return verified.ok ? verified.actor : { refused: verified.description };
    }
    // Covers JWKS/auth-api fetches without changing the verifier or its cache.
    const actor = await spans.record({ name: "mcp.auth.oauth.verify", op: "auth" }, () =>
      verifier.verify(authorization, audience, Math.floor(nowMs / 1000)),
    );
    if (!actor) return null;
    const revoked = await spans.record({ name: "mcp.auth.revocation", op: "auth" }, async () => {
      if (!options.revocations) {
        throw new Error("mcp-server: SESSION_STORE revocation binding is required");
      }
      return options.revocations.isRevoked(actor.subject, actor.issuedAt);
    });
    return revoked ? null : actor;
  });
}
