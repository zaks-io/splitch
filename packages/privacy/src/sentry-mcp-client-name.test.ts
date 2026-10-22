import { expect, it } from "vitest";
import { scrubSentrySpan } from "./sentry-scrubber";

it.each(["attributes", "data"])("enforces canonical MCP client names in span %s", (field) => {
  for (const value of ["codex", "mcp-inspector", "other"]) {
    const span = scrubSentrySpan({ [field]: { "mcp.client.name": value } });
    expect(span[field]).toEqual({ "mcp.client.name": value });
  }
  for (const value of [
    "user_7f3c9a2b",
    "550e8400-e29b-41d4-a716-446655440000",
    "2001:db8:85a3::8a2e:370:7334",
    "Private workspace for the confidential acquisition planning team. ".repeat(4),
    "person@example.com",
    "codex-mcp-client",
    "CODEX",
    "codex private workspace",
    "constructor",
    "__proto__",
    42,
    null,
    ["codex"],
    { name: "codex" },
  ]) {
    const span = scrubSentrySpan({
      [field]: { "mcp.client.name": value, "mcp.client.version": "private-version" },
    });
    expect(span[field]).toEqual({
      "mcp.client.name": "other",
      "mcp.client.version": "[Redacted]",
    });
  }
});
