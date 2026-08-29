/**
 * The docs URL shape, in one place. `@splitch/sdk` builds the same
 * `/docs/error/{code}` URL in `resolveErrorDocsUrl` so that every printed error
 * message resolves here. `errors/error-catalog.test.ts` holds the two in
 * agreement, because a drift would 404 every link the SDK and CLI print.
 */
export const DOCS_ORIGIN = "https://splitch.dev";

export const docsPath = {
  index: () => "/docs",
  flags: () => "/docs/flags",
  flagsMarkdown: () => "/docs/flags.md",
  cli: () => "/docs/cli",
  cliMarkdown: () => "/docs/cli.md",
  errors: () => "/docs/errors",
  errorsMarkdown: () => "/docs/errors.md",
  codeAgents: () => "/docs/code-agents",
  codeAgentsMarkdown: () => "/docs/code-agents.md",
  sdkTopic: (slug: string) => `/docs/sdk/${slug}`,
  sdkTopicMarkdown: (slug: string) => `/docs/sdk/${slug}.md`,
  errorCode: (code: string) => `/docs/error/${code}`,
  errorCodeMarkdown: (code: string) => `/docs/error/${code}.md`,
} as const;
