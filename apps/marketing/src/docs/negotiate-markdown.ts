import { markdownForPath } from "./markdown-route";
import {
  acceptsMarkdown,
  hasMarkdownMediaRange,
  markdownResponse,
  withVaryAccept,
} from "./serve-markdown";

type MarkdownNegotiation<TRequest extends Request> =
  | { kind: "response"; response: Response }
  | { kind: "render"; request: TRequest };

export function negotiateMarkdownRequest<TRequest extends Request>(
  request: TRequest,
): MarkdownNegotiation<TRequest> {
  if ((request.method !== "GET" && request.method !== "HEAD") || !hasMarkdownMediaRange(request)) {
    return { kind: "render", request };
  }

  if (acceptsMarkdown(request)) {
    const markdown = markdownForPath(new URL(request.url).pathname);
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
