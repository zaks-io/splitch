import { createFileRoute } from "@tanstack/react-router";
import { quickstartMarkdown } from "../docs/markdown";
import { markdownResponse } from "../docs/serve-markdown";

export const Route = createFileRoute("/quickstart.md")({
  server: {
    handlers: {
      GET: async () => markdownResponse(quickstartMarkdown()),
    },
  },
});
