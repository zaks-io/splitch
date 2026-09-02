import { createFileRoute } from "@tanstack/react-router";

/** The Control Panel is a private, authenticated surface: keep it out of every index. */
const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

export function robotsResponse(): Response {
  return new Response(ROBOTS_TXT, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: async () => robotsResponse(),
    },
  },
});
