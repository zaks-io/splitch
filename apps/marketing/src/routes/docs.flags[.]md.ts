import { createFileRoute } from "@tanstack/react-router";
import { flagsDocMarkdown } from "../docs/markdown";
import { markdownResponse } from "../docs/serve-markdown";

export const Route = createFileRoute("/docs/flags.md")({
  server: {
    handlers: {
      GET: async () => markdownResponse(flagsDocMarkdown()),
    },
  },
});
