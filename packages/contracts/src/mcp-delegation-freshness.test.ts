import { describe, expect, it } from "vitest";
import { createMcpDelegationHeader, parseMcpDelegation } from "./index";
import {
  type McpDelegationFreshnessFailure,
  mcpDelegationFreshnessFailure,
} from "./mcp-delegation";
import {
  memoryReplayGuard,
  resignCredential,
  SECRET,
  withCredential,
} from "./mcp-delegation-test-fixtures";

describe("MCP delegated credential freshness", () => {
  it.each([
    {
      name: "issuedAt beyond the clock-skew ceiling",
      patch: { issuedAt: 106, expiresAt: 130 },
      failure: "issued_at_too_new",
    },
    {
      name: "issuedAt before the deploy window",
      patch: { issuedAt: 69, expiresAt: 99 },
      failure: "issued_at_too_old",
    },
    {
      name: "expiresAt at the current second",
      patch: { issuedAt: 70, expiresAt: 100 },
      failure: "expired",
    },
    {
      name: "expiresAt beyond the maximum TTL",
      patch: { issuedAt: 100, expiresAt: 131 },
      failure: "ttl_too_long",
    },
  ] satisfies ReadonlyArray<{
    name: string;
    patch: { issuedAt: number; expiresAt: number };
    failure: McpDelegationFreshnessFailure;
  }>)("rejects a signed credential with $name", async ({ patch, failure }) => {
    const request = new Request("https://control-plane.internal/apps/app_one/flags");
    const credential = await createMcpDelegationHeader({
      operationId: "flags_list",
      actor: { subject: "user_one", scopes: ["app:app_one:admin"], authDoor: "id_jag" },
      request,
      secret: SECRET,
      nowSeconds: 100,
      jti: `delegation-freshness-${failure}`,
    });
    const changed = await resignCredential(credential, patch);

    expect(mcpDelegationFreshnessFailure(patch.issuedAt, patch.expiresAt, 100)).toBe(failure);
    await expect(
      parseMcpDelegation({
        request: withCredential(request, changed),
        surface: "control-plane-api",
        secret: SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 100,
      }),
    ).resolves.toBeNull();
  });
});
