import { createFileRoute } from "@tanstack/react-router";
import { cliDocMarkdown } from "../docs/markdown";
import { markdownResponse } from "../docs/serve-markdown";

export const Route = createFileRoute("/docs/cli.md")({
  server: {
    handlers: {
      GET: async () => markdownResponse(cliDocMarkdown()),
    },
  },
});
