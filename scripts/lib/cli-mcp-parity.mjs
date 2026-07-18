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
