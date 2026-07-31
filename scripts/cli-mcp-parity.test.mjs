import assert from "node:assert/strict";
import test from "node:test";
import { assertCliMcpParity, assertPublicAgentSurface } from "./lib/cli-mcp-parity.mjs";

const completeFixture = {
  contractOperationIds: ["apps_list"],
  cliOperationIds: ["apps_list"],
  mcpOperationIds: ["apps_list"],
  exceptions: [],
  skinLocalCapabilities: [{ name: "active context selection", cliPresent: true, mcpPresent: true }],
};

test("accepts matching contract, CLI, MCP, and skin-local capabilities", () => {
  assert.doesNotThrow(() => assertCliMcpParity(completeFixture));
});

test("fails loud when a contract route and CLI capability are missing from MCP", () => {
  const driftedFixture = {
    ...completeFixture,
    contractOperationIds: [...completeFixture.contractOperationIds, "fixture_operation"],
    cliOperationIds: [...completeFixture.cliOperationIds, "fixture_operation"],
  };

  assert.throws(
    () => assertCliMcpParity(driftedFixture),
    /cli-mcp-parity: missing MCP tools: fixture_operation/,
  );
});

test("rejects repo-internal references from rendered CLI help", () => {
  for (const reference of [
    "ADR-0026",
    "SPL-278",
    "../internal.md",
    "./internal.md",
    "docs/adr/0026.md",
    "apps/cli/src/help.ts",
    "packages/contracts/src/index.ts",
    ".github/workflows/ci.yml",
    "AGENTS.md",
    "CONTEXT.md",
  ]) {
    assert.throws(
      () =>
        assertPublicAgentSurface({
          cliHelp: [{ name: "flags test-eval", text: `Resolve a Flag. See ${reference}` }],
          mcpTools: [],
        }),
      /published-agent-surface: CLI help "flags test-eval" contains repo-internal reference/,
    );
  }
});

test("rejects repo-internal references from derived MCP tool descriptions", () => {
  assert.throws(
    () =>
      assertPublicAgentSurface({
        cliHelp: [],
        mcpTools: [{ name: "flags_test_eval", description: "See ADR-0026." }],
      }),
    /published-agent-surface: MCP tool description "flags_test_eval" contains repo-internal reference: ADR-0026/,
  );
});
