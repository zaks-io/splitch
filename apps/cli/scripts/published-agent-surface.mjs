/**
 * Shared published-agent-surface refusal: CLI README pack, CLI/MCP parity gate,
 * and any other surface that must stay free of repo-internal references.
 *
 * Two real consumers today: apps/cli/scripts/pack-staging.mjs and
 * scripts/lib/cli-mcp-parity.mjs. Lives under apps/cli/scripts so the CLI
 * prepare-artifacts scratch tree (which copies only the package) can resolve it.
 */
const REPO_INTERNAL_REFERENCE =
  /(?:^|[\s`(])(?:\.\.\/|\.\/|docs\/|apps\/|packages\/|\.github\/|AGENTS\.md|CONTEXT\.md)|(?:ADR|SPL)-\d+/m;

export function findRepoInternalReference(text) {
  const match = text.match(REPO_INTERNAL_REFERENCE);
  return match ? match[0].trim() : null;
}
