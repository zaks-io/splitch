import { createFileRoute } from "@tanstack/react-router";
import { sitemapXml } from "../docs/sitemap";

export function sitemapResponse(): Response {
  return new Response(sitemapXml(), {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => sitemapResponse(),
    },
  },
});
