import { describe, expect, it } from "vitest";
import { callWithThrowingSessionStore } from "./mcp-throwing-session-store.test-fixture";

const INTERNAL_ERROR = -32603;

describe("MCP session store fault", () => {
  it("propagates a throwing session store as an internal fault, never an unresolved scope", async () => {
    // mcp-session-context.ts's resolveScope documents the invariant: a session
    // store that throws mid-read is an outage, not an unresolved scope, so it
    // must reach the internal-error path rather than posing as a caller fix
    // (SPL-313 finding).
    const { body, calls } = await callWithThrowingSessionStore();

    expect(body.error).toMatchObject({ code: INTERNAL_ERROR, message: "Internal error" });
    expect(body.result).toBeUndefined();
    // The fixture's store resolves once (mcp-transport.ts's validateSession
    // read) then throws (resolveScope's own read, mcp-session-context.ts:82).
    // Two calls proves the fault reached resolveScope, not that the transport
    // swallowed it earlier.
    expect(calls, "expected validateSession's read plus resolveScope's throwing read").toBe(2);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("scope is unresolved");
    expect(serialized).not.toContain("did not resolve");
  });
});
