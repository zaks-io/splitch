import { blocksToMarkdown } from "./blocks";
import { cliDoc } from "./cli";
import { codeAgentsDoc } from "./code-agents";
import {
  type DocumentedErrorCode,
  documentedCodesBySurface,
  documentedErrorCodes,
  errorCodeMarker,
  errorDocs,
  errorSurfaces,
  httpStatusForDocumentedCode,
  surfaceBlurbs,
  surfaceForCode,
  surfaceLabels,
} from "./errors";
import { flagsDoc } from "./flags";
import { type SdkTopic, sdkGuideTopics, sdkIntegrationTopics } from "./sdk";
import { DOCS_ORIGIN, docsPath } from "./site";

export function sdkTopicMarkdown(topic: SdkTopic): string {
  return [
    `# ${topic.title}`,
    topic.summary,
    blocksToMarkdown(topic.blocks),
    `Source: ${DOCS_ORIGIN}${docsPath.sdkTopic(topic.slug)}`,
  ].join("\n\n");
}

export function flagsDocMarkdown(): string {
  return [
    `# ${flagsDoc.title}`,
    flagsDoc.summary,
    blocksToMarkdown(flagsDoc.blocks),
    `Source: ${DOCS_ORIGIN}${docsPath.flags()}`,
  ].join("\n\n");
}

export function cliDocMarkdown(): string {
  return [
    `# ${cliDoc.title}`,
    cliDoc.summary,
    blocksToMarkdown(cliDoc.blocks),
    `Source: ${DOCS_ORIGIN}${docsPath.cli()}`,
  ].join("\n\n");
}

export function codeAgentsDocMarkdown(): string {
  return [
    `# ${codeAgentsDoc.title}`,
    codeAgentsDoc.summary,
    blocksToMarkdown(codeAgentsDoc.blocks),
    `Source: ${DOCS_ORIGIN}${docsPath.codeAgents()}`,
  ].join("\n\n");
}

export function errorMarkdown(code: DocumentedErrorCode): string {
  const doc = errorDocs[code];
  const status = httpStatusForDocumentedCode(code);
  const facts = [`Surface: ${surfaceLabels[surfaceForCode(code)]}`];
  if (status !== null) facts.push(`HTTP status: ${status}`);
  if (doc.exitCode !== undefined) facts.push(`Exit code: ${doc.exitCode}`);
  if (doc.recommendedAction) facts.push(`Recommended action: \`${doc.recommendedAction}\``);
  if (doc.details) facts.push(`Details: \`${doc.details}\``);

  // Remediation leads: an agent reading this page is mid-failure, and the one
  // action that clears the code should be readable before the explanation of it.
  const sections = [`# ${code}`, facts.map((fact) => `- ${fact}`).join("\n")];
  if (doc.remediation) sections.push(`## Remediation\n\n${doc.remediation}`);
  sections.push(`## Cause\n\n${doc.cause}`, `## Fix\n\n${doc.fix}`);
  if (doc.related?.length) {
    sections.push(
      `## Related\n\n${doc.related
        .map((related) => `- [${related}](${DOCS_ORIGIN}${docsPath.errorCode(related)})`)
        .join("\n")}`,
    );
  }
  sections.push(`Source: ${DOCS_ORIGIN}${docsPath.errorCode(code)}`);
  return sections.join("\n\n");
}

/**
 * The full catalog on one page. It lives here rather than in `llms.txt` because
 * an agent reads the index on every task and the catalog only when something
 * failed; inlining 80-odd causes made the entry point mostly error copy.
 */
export function errorIndexMarkdown(): string {
  const bySurface = documentedCodesBySurface();
  const line = (code: DocumentedErrorCode) => {
    const marker = errorCodeMarker(code);
    const prefix = marker === null ? "" : `${marker}. `;
    return `- [${code}](${DOCS_ORIGIN}${docsPath.errorCodeMarkdown(code)}): ${prefix}${errorDocs[code].cause}`;
  };

  return [
    "# splitch error codes",
    `Every failure code the API, SDK, and CLI can emit. Each one also has its own page at ${DOCS_ORIGIN}/docs/error/{code}.md carrying its cause, its fix, and the action that clears it: that is the URL printed in the error message itself.`,
    ...errorSurfaces.flatMap((surface) => [
      `## ${surfaceLabels[surface]} (${bySurface[surface].length})`,
      surfaceBlurbs[surface],
      bySurface[surface].map(line).join("\n"),
    ]),
    `Source: ${DOCS_ORIGIN}${docsPath.errors()}`,
  ].join("\n\n");
}

/**
 * The agent entry point. Every page is listed with its `.md` URL, because an
 * agent that has to guess which pages exist will guess wrong and report a 404 as
 * an absence of documentation.
 */
export function llmsTxt(): string {
  const topicLine = (topic: SdkTopic) =>
    `- [${topic.title}](${DOCS_ORIGIN}${docsPath.sdkTopicMarkdown(topic.slug)}): ${topic.summary}`;
  const bySurface = documentedCodesBySurface();
  const counts = errorSurfaces
    .map((surface) => `${bySurface[surface].length} ${surfaceLabels[surface]}`)
    .join(", ");

  return [
    "# splitch",
    "> Feature flags and A/B experimentation with agent parity: every capability a person has in the panel is available to an agent over MCP, the CLI, and the SDK. Failures are always observable and never disguised as a default.",
    "Every page below is also served as HTML at the same URL without the `.md` suffix.",
    "## Flags",
    `- [${flagsDoc.title}](${DOCS_ORIGIN}${docsPath.flagsMarkdown()}): ${flagsDoc.summary}`,
    "## CLI",
    `- [${cliDoc.title}](${DOCS_ORIGIN}${docsPath.cliMarkdown()}): ${cliDoc.summary}`,
    "Every command accepts `--json` (one line on stdout, failures included) and `--help`. Policy-gated changes take `--confirm`.",
    "## Code-agent implementation",
    `- [${codeAgentsDoc.title}](${DOCS_ORIGIN}${docsPath.codeAgentsMarkdown()}): ${codeAgentsDoc.summary}`,
    "## Integrations",
    "One guide per runtime, each from `npm install` to a first resolving Flag. `@splitch/sdk` covers Node, browsers, and React; Convex and Cloudflare Workers each ship their own package.",
    sdkIntegrationTopics.map(topicLine).join("\n"),
    "## SDK",
    "The contract every integration shares.",
    sdkGuideTopics.map(topicLine).join("\n"),
    "## Errors",
    `- [Error codes](${DOCS_ORIGIN}${docsPath.errorsMarkdown()}): the whole catalog, ${documentedErrorCodes.length} codes (${counts}), each with its cause. Read it when something failed.`,
    `Every code also resolves to a page of its own at ${DOCS_ORIGIN}/docs/error/{code}.md, which is the URL the API, SDK, and CLI print alongside the failure.`,
    "## Optional",
    [
      `- [Quickstart](${DOCS_ORIGIN}/quickstart): zero to a resolving Flag with the CLI.`,
      "- [MCP server](https://mcp.splitch.dev): the same capabilities in-band for agents.",
      "- [Control Panel](https://app.splitch.dev)",
    ].join("\n"),
  ].join("\n\n");
}
