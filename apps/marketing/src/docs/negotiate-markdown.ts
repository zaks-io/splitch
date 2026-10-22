import {
  acceptsMarkdown,
  hasMarkdownMediaRange,
  markdownResponse,
  withVaryAccept,
} from "./serve-markdown";

type MarkdownNegotiation<TRequest extends Request> =
  | { kind: "response"; response: Response }
  | { kind: "render"; request: TRequest };

export async function negotiateMarkdownRequest<TRequest extends Request>(
  request: TRequest,
): Promise<MarkdownNegotiation<TRequest>> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return { kind: "render", request };
  }

  const pathname = new URL(request.url).pathname;
  // Append `.md` to any page: the URL itself selects the markdown representation.
  // Do not require Accept: text/markdown — agents and curl follow the README rule.
  if (pathname.endsWith(".md")) {
    const { markdownForPath } = await import("./markdown-route");
    const markdown = markdownForPath(pathname);
    if (markdown !== null) {
      return {
        kind: "response",
        response: markdownResponse(markdown, request.method),
      };
    }
    return { kind: "render", request };
  }

  if (!hasMarkdownMediaRange(request)) {
    return { kind: "render", request };
  }

  if (acceptsMarkdown(request)) {
    const { markdownForPath } = await import("./markdown-route");
    const markdown = markdownForPath(pathname);
    if (markdown !== null) {
      return {
        kind: "response",
        response: withVaryAccept(markdownResponse(markdown, request.method)),
      };
    }
  }

  const headers = new Headers(request.headers);
  headers.set("accept", "text/html");
  return { kind: "render", request: new Request(request, { headers }) as TRequest };
}
