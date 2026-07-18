import assert from "node:assert/strict";
import test from "node:test";
import { assertCliMcpParity } from "./lib/cli-mcp-parity.mjs";

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
