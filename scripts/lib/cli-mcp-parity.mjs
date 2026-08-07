import { findRepoInternalReference } from "../../apps/cli/scripts/published-agent-surface.mjs";

function uniqueIds(ids, surface) {
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    throw new Error(`cli-mcp-parity: duplicate ${surface} capability "${duplicate}"`);
  }
  return unique;
}

function missingIds(expected, actual) {
  return [...expected].filter((id) => !actual.has(id)).sort();
}

function unexpectedIds(expected, actual) {
  return [...actual].filter((id) => !expected.has(id)).sort();
}

function assertSurface(surface, expected, actual) {
  const missing = missingIds(expected, actual);
  const unexpected = unexpectedIds(expected, actual);
  if (missing.length === 0 && unexpected.length === 0) return;

  const details = [
    missing.length > 0 ? `missing ${surface}: ${missing.join(", ")}` : undefined,
    unexpected.length > 0 ? `unexpected ${surface}: ${unexpected.join(", ")}` : undefined,
  ].filter(Boolean);
  throw new Error(`cli-mcp-parity: ${details.join("; ")}`);
}

function assertExceptions(contract, exceptions) {
  const exceptionIds = uniqueIds(
    exceptions.map((exception) => exception.operationId),
    "exception",
  );
  const unknown = unexpectedIds(contract, exceptionIds);
  if (unknown.length > 0) {
    throw new Error(`cli-mcp-parity: exceptions not found in contract: ${unknown.join(", ")}`);
  }
  for (const exception of exceptions) {
    if (typeof exception.reason !== "string" || exception.reason.length === 0) {
      throw new Error(
        `cli-mcp-parity: exception "${exception.operationId}" must document its reason`,
      );
    }
  }
}

function expectedOperations(contract, exceptions, surface) {
  const expected = new Set(contract);
  for (const exception of exceptions) {
    if (!exception[surface]) expected.delete(exception.operationId);
  }
  return expected;
}

function assertSkinLocalCapabilities(capabilities) {
  for (const capability of capabilities) {
    if (capability.cliPresent && capability.mcpPresent) continue;

    let missingSurface = "CLI and MCP";
    if (capability.cliPresent) missingSurface = "MCP";
    if (capability.mcpPresent) missingSurface = "CLI";
    throw new Error(
      `cli-mcp-parity: skin-local capability "${capability.name}" is missing from ${missingSurface}`,
    );
  }
}

function assertPublicEntries(entries, surface) {
  for (const entry of entries) {
    const internalReference = findRepoInternalReference(entry.text);
    if (internalReference) {
      throw new Error(
        `published-agent-surface: ${surface} "${entry.name}" contains repo-internal reference: ${internalReference}`,
      );
    }
  }
}

export function assertPublicAgentSurface({
  cliHelp,
  mcpTools,
  mcpPrompts = [],
  mcpResources = [],
  routeSummaries = [],
}) {
  assertPublicEntries(cliHelp, "CLI help");
  assertPublicEntries(
    mcpTools.map((tool) => ({ name: tool.name, text: tool.description })),
    "MCP tool description",
  );
  assertPublicEntries(mcpPrompts, "MCP prompt");
  assertPublicEntries(mcpResources, "MCP resource");
  assertPublicEntries(routeSummaries, "route summary");
}

export function assertCliMcpParity({
  contractOperationIds,
  cliOperationIds,
  mcpOperationIds,
  exceptions,
  skinLocalCapabilities,
}) {
  const contract = uniqueIds(contractOperationIds, "contract");
  const cli = uniqueIds(cliOperationIds, "CLI");
  const mcp = uniqueIds(mcpOperationIds, "MCP");
  assertExceptions(contract, exceptions);

  assertSurface("CLI operations", expectedOperations(contract, exceptions, "cli"), cli);
  assertSurface("MCP tools", expectedOperations(contract, exceptions, "mcp"), mcp);
  assertSkinLocalCapabilities(skinLocalCapabilities);
}

/**
 * Equal operation IDs are not equal surfaces: an agent that passes a tool-schema
 * check and is then rejected by the Worker is the failure ADR-0023 exists to
 * prevent. Both skins must publish the JSON Schema derived from the one route
 * contract, so a hand-written tool definition or a skin-local schema override
 * fails here.
 */
export function assertCliMcpSchemaParity({ cliSchemas, mcpSchemas }) {
  const cliOperations = [...cliSchemas.keys()].sort();
  const mcpOperations = [...mcpSchemas.keys()].sort();
  if (cliOperations.join(",") !== mcpOperations.join(",")) {
    throw new Error(
      `cli-mcp-parity: schema coverage differs. CLI: ${cliOperations.join(", ")}; MCP: ${mcpOperations.join(", ")}`,
    );
  }
  for (const operationId of cliOperations) {
    for (const kind of ["input", "output"]) {
      const cli = JSON.stringify(cliSchemas.get(operationId)[kind]);
      const mcp = JSON.stringify(mcpSchemas.get(operationId)[kind]);
      if (cli !== mcp) {
        throw new Error(
          `cli-mcp-parity: ${operationId} ${kind} schema differs between surfaces\n  CLI: ${cli}\n  MCP: ${mcp}`,
        );
      }
    }
  }
  return cliOperations.length;
}
