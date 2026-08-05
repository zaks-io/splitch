import { createFileRoute } from "@tanstack/react-router";
import { llmsTxt } from "../docs/markdown";

export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: async () =>
        new Response(llmsTxt(), {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "public, max-age=300",
          },
        }),
    },
  },
});
