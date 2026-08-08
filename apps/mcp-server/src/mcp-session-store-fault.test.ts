import { describe, expect, it } from "vitest";
import { callWithThrowingSessionStore } from "./mcp-throwing-session-store.test-fixture";

describe("MCP session context", () => {
  it("propagates a throwing session store as an internal fault, never an unresolved scope", async () => {
    // mcp-session-context.ts's resolveScope documents the invariant: a session
    // store that throws mid-read is an outage, not an unresolved scope, so it
    // must reach the internal-error path rather than posing as a caller fix
    // (SPL-313 finding).
    const { body, calls } = await callWithThrowingSessionStore();

    expect(body.error).toMatchObject({ code: -32603, message: "Internal error" });
    expect(body.result).toBeUndefined();
    expect(calls).toBe(2);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("scope is unresolved");
    expect(serialized).not.toContain("did not resolve");
  });
});
