import { createFileRoute } from "@tanstack/react-router";
import { codeAgentsDocMarkdown } from "../docs/markdown";
import { markdownResponse } from "../docs/serve-markdown";

export const Route = createFileRoute("/docs/code-agents.md")({
  server: {
    handlers: {
      GET: async () => markdownResponse(codeAgentsDocMarkdown()),
    },
  },
});
