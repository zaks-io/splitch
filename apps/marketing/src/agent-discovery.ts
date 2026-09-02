const API_CATALOG_PATH = "/.well-known/api-catalog";
const CONTROL_PLANE_ORIGIN = "https://api.splitch.dev";

export const homepageLinkHeader = [
  `<${API_CATALOG_PATH}>; rel="api-catalog"; type="application/linkset+json"`,
  `<${CONTROL_PLANE_ORIGIN}/.well-known/openapi.json>; rel="service-desc"; type="application/json"`,
  `</docs/code-agents.md>; rel="service-doc"; type="text/markdown"`,
  `</llms.txt>; rel="describedby"; type="text/plain"`,
].join(", ");

export function withHomepageLinkHeaders(request: Request, response: Response): Response {
  const url = new URL(request.url);
  if (url.pathname !== "/" || !["GET", "HEAD"].includes(request.method)) return response;

  const headers = new Headers(response.headers);
  headers.append("link", homepageLinkHeader);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
