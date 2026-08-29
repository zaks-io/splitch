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
 * MCP must publish the JSON Schema derived from the route contracts. Comparing
 * the canonical derivation with the registered tools catches a hand-written MCP
 * definition or wrapper override; CLI validation is not exercised here.
 */
export function assertDerivedMcpSchemaParity({ derivedSchemas, publishedSchemas }) {
  const derivedOperations = [...derivedSchemas.keys()].sort();
  const publishedOperations = [...publishedSchemas.keys()].sort();
  if (derivedOperations.join(",") !== publishedOperations.join(",")) {
    throw new Error(
      `cli-mcp-parity: schema coverage differs. Derived: ${derivedOperations.join(", ")}; published MCP: ${publishedOperations.join(", ")}`,
    );
  }
  for (const operationId of derivedOperations) {
    for (const kind of ["input", "output"]) {
      const derived = JSON.stringify(derivedSchemas.get(operationId)[kind]);
      const published = JSON.stringify(publishedSchemas.get(operationId)[kind]);
      if (derived !== published) {
        throw new Error(
          `cli-mcp-parity: ${operationId} ${kind} schema differs from the published MCP tool\n  Derived: ${derived}\n  Published MCP: ${published}`,
        );
      }
    }
  }
  return derivedOperations.length;
}

export function assertFlagReadSummaryParity({ cliHelp, mcpInputSchemas }) {
  for (const operationId of ["flags_list", "flags_get"]) {
    const help = cliHelp.get(operationId);
    if (typeof help !== "string" || !help.includes("--summary")) {
      throw new Error(`cli-mcp-parity: ${operationId} CLI is missing --summary`);
    }
    const schema = mcpInputSchemas.get(operationId);
    const summary = schema?.properties?.summary;
    if (!summary || summary.type !== "boolean") {
      throw new Error(`cli-mcp-parity: ${operationId} MCP is missing boolean summary`);
    }
  }
  return 2;
}
