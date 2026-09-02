import { createFileRoute } from "@tanstack/react-router";
import { robotsTxt } from "../docs/sitemap";

export function robotsResponse(): Response {
  return new Response(robotsTxt(), {
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
