/**
 * Docs URLs an MCP results response may attach as a resource_link. Paths must
 * already exist on the public docs site (`apps/marketing/src/docs/site.ts`);
 * never invent a /docs/... URL.
 */

const DOCS_ORIGIN = "https://splitch.dev";

/** Static docs pages from the marketing sitemap (not error-code or SDK topic pages). */
const PUBLISHED_STATIC_DOCS_PATHS = new Set([
  "/docs",
  "/docs/flags",
  "/docs/cli",
  "/docs/errors",
  "/docs/code-agents",
]);

/**
 * Experiment results field docs. There is no `/docs/experiment-results` (or
 * equivalent) page on the docs site today, so this stays unset on purpose.
 */
const RESULTS_FIELDS_DOCS_PATH: Readonly<Record<string, string | undefined>> = {
  experiment_results_get: undefined,
  experiment_results_post: undefined,
};

export function resultsFieldsDocsUrl(operationId: string): string | undefined {
  if (!(operationId in RESULTS_FIELDS_DOCS_PATH)) return undefined;
  const path = RESULTS_FIELDS_DOCS_PATH[operationId];
  if (path === undefined) return undefined;
  if (!PUBLISHED_STATIC_DOCS_PATHS.has(path)) {
    throw new Error(
      `mcp-server: results docs path "${path}" for "${operationId}" is not a published docs page`,
    );
  }
  return `${DOCS_ORIGIN}${path}`;
}

export function resultsFieldsResourceLink(
  operationId: string,
): { type: "resource_link"; uri: string; name: string } | undefined {
  const uri = resultsFieldsDocsUrl(operationId);
  if (!uri) return undefined;
  return {
    type: "resource_link",
    uri,
    name: "Experiment results fields",
  };
}
