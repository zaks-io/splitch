const API_CATALOG_URL = "https://splitch.dev/.well-known/api-catalog";
const OPENAPI_URL = "https://api.splitch.dev/.well-known/openapi.json";

export const apiCatalog = {
  linkset: [
    {
      anchor: "https://api.splitch.dev",
      "service-desc": [{ href: OPENAPI_URL, type: "application/json" }],
      "service-doc": [{ href: "https://splitch.dev/docs/cli", type: "text/html" }],
      status: [{ href: "https://api.splitch.dev/health", type: "application/json" }],
    },
    {
      anchor: "https://edge.splitch.dev",
      "service-desc": [{ href: OPENAPI_URL, type: "application/json" }],
      "service-doc": [{ href: "https://splitch.dev/docs/sdk/methods", type: "text/html" }],
      status: [{ href: "https://edge.splitch.dev/health", type: "application/json" }],
    },
  ],
} as const;

const headers = {
  "content-type": 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
  "cache-control": "public, max-age=300",
  link: `<${API_CATALOG_URL}>; rel="api-catalog"`,
};

export function apiCatalogResponse(method: "GET" | "HEAD"): Response {
  return new Response(method === "HEAD" ? null : JSON.stringify(apiCatalog), { headers });
}
