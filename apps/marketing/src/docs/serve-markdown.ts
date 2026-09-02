const MARKDOWN_SUFFIX = ".md";

/** `install.md` -> `install`; `install` -> null. */
export function markdownSlug(param: string): string | null {
  return param.endsWith(MARKDOWN_SUFFIX) ? param.slice(0, -MARKDOWN_SUFFIX.length) : null;
}

export function markdownResponse(body: string, method: "GET" | "HEAD" = "GET"): Response {
  return new Response(method === "HEAD" ? null : body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

export function acceptsMarkdown(request: Pick<Request, "headers">): boolean {
  const accept = request.headers.get("accept");
  if (accept === null) return false;

  return accept.split(",").some((entry) => {
    const [mediaType, ...parameters] = entry.split(";").map((part) => part.trim());
    if (mediaType?.toLowerCase() !== "text/markdown") return false;
    const quality = parameters.find((parameter) => parameter.toLowerCase().startsWith("q="));
    if (quality === undefined) return true;
    const value = Number(quality.slice(2));
    return Number.isFinite(value) && value > 0;
  });
}

export function hasMarkdownMediaRange(request: Pick<Request, "headers">): boolean {
  return (
    request.headers
      .get("accept")
      ?.split(",")
      .some((entry) => entry.split(";", 1)[0]?.trim().toLowerCase() === "text/markdown") ?? false
  );
}

export function markdownNotFound(body: string): Response {
  return new Response(`${body}\n`, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export function withVaryAccept(response: Response): Response {
  const headers = new Headers(response.headers);
  const vary = headers
    .get("vary")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!vary?.some((value) => value.toLowerCase() === "accept")) {
    headers.set("vary", [...(vary ?? []), "Accept"].join(", "));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
