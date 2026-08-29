import { createFileRoute } from "@tanstack/react-router";
import { errorIndexMarkdown } from "../docs/markdown";
import { markdownResponse } from "../docs/serve-markdown";

export const Route = createFileRoute("/docs/errors.md")({
  server: {
    handlers: {
      GET: async () => markdownResponse(errorIndexMarkdown()),
    },
  },
});
