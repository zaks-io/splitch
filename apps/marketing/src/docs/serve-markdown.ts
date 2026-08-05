const MARKDOWN_SUFFIX = ".md";

/** `install.md` -> `install`; `install` -> null. */
export function markdownSlug(param: string): string | null {
  return param.endsWith(MARKDOWN_SUFFIX) ? param.slice(0, -MARKDOWN_SUFFIX.length) : null;
}

export function markdownResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

export function markdownNotFound(body: string): Response {
  return new Response(`${body}\n`, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
