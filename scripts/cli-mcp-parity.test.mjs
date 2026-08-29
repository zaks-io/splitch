import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCliMcpParity,
  assertFlagReadSummaryParity,
  assertPublicAgentSurface,
} from "./lib/cli-mcp-parity.mjs";
import { findRepoInternalReference } from "../apps/cli/scripts/published-agent-surface.mjs";

const completeFixture = {
  contractOperationIds: ["apps_list"],
  cliOperationIds: ["apps_list"],
  mcpOperationIds: ["apps_list"],
  exceptions: [],
  skinLocalCapabilities: [{ name: "active context selection", cliPresent: true, mcpPresent: true }],
};

const emptySurface = {
  cliHelp: [],
  mcpTools: [],
  mcpPrompts: [],
  mcpResources: [],
  routeSummaries: [],
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

test("fails loud when a Flag-read summary field is missing from MCP", () => {
  assert.throws(
    () =>
      assertFlagReadSummaryParity({
        cliHelp: new Map([
          ["flags_list", "--summary"],
          ["flags_get", "--summary"],
        ]),
        mcpInputSchemas: new Map([
          ["flags_list", { properties: { summary: { type: "boolean" } } }],
          ["flags_get", { properties: {} }],
        ]),
      }),
    /cli-mcp-parity: flags_get MCP is missing boolean summary/,
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
          ...emptySurface,
          cliHelp: [{ name: "flags test-eval", text: `Resolve a Flag. See ${reference}` }],
        }),
      /published-agent-surface: CLI help "flags test-eval" contains repo-internal reference/,
    );
  }
});

test("rejects repo-internal references from derived MCP tool descriptions", () => {
  assert.throws(
    () =>
      assertPublicAgentSurface({
        ...emptySurface,
        mcpTools: [{ name: "flags_test_eval", description: "See ADR-0026." }],
      }),
    /published-agent-surface: MCP tool description "flags_test_eval" contains repo-internal reference: ADR-0026/,
  );
});

test("rejects repo-internal references from MCP prompt text", () => {
  assert.throws(
    () =>
      assertPublicAgentSurface({
        ...emptySurface,
        mcpPrompts: [
          {
            name: "onboard_new_app:message[0]",
            text: "Confirm the live Run resolves (ADR-0037).",
          },
        ],
      }),
    /published-agent-surface: MCP prompt "onboard_new_app:message\[0\]" contains repo-internal reference: ADR-0037/,
  );
});

test("rejects repo-internal references from MCP resource contents", () => {
  assert.throws(
    () =>
      assertPublicAgentSurface({
        ...emptySurface,
        mcpResources: [
          {
            name: "splitch://quickstart",
            text: "See [CONTEXT.md](../../CONTEXT.md) and ADR-0023.",
          },
        ],
      }),
    /published-agent-surface: MCP resource "splitch:\/\/quickstart" contains repo-internal reference/,
  );
});

test("rejects repo-internal references from route summaries", () => {
  assert.throws(
    () =>
      assertPublicAgentSurface({
        ...emptySurface,
        routeSummaries: [{ name: "sdk_peek", text: "Peek a Flag (ADR-0037)." }],
      }),
    /published-agent-surface: route summary "sdk_peek" contains repo-internal reference: ADR-0037/,
  );
});

test("shared published-agent-surface helper matches the pack-staging refusal shape", () => {
  assert.equal(findRepoInternalReference("See ADR-0026."), "ADR-0026");
  assert.equal(findRepoInternalReference("Public prose only."), null);
});
