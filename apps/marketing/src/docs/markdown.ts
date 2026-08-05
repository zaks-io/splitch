import { blocksToMarkdown } from "./blocks";
import {
  type DocumentedErrorCode,
  documentedErrorCodes,
  errorDocs,
  httpStatusForDocumentedCode,
  surfaceForCode,
  surfaceLabels,
} from "./errors";
import { flagsDoc } from "./flags";
import { type SdkTopic, sdkTopics } from "./sdk";
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

export function errorMarkdown(code: DocumentedErrorCode): string {
  const doc = errorDocs[code];
  const status = httpStatusForDocumentedCode(code);
  const facts = [`Surface: ${surfaceLabels[surfaceForCode(code)]}`];
  if (status !== null) facts.push(`HTTP status: ${status}`);
  if (doc.exitCode !== undefined) facts.push(`Exit code: ${doc.exitCode}`);
  if (doc.recommendedAction) facts.push(`Recommended action: \`${doc.recommendedAction}\``);
  if (doc.details) facts.push(`Details: \`${doc.details}\``);

  const sections = [
    `# ${code}`,
    facts.map((fact) => `- ${fact}`).join("\n"),
    `## Cause\n\n${doc.cause}`,
    `## Fix\n\n${doc.fix}`,
  ];
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
 * The agent entry point. Every page is listed with its `.md` URL, because an
 * agent that has to guess which pages exist will guess wrong and report a 404 as
 * an absence of documentation.
 */
export function llmsTxt(): string {
  const topicLines = sdkTopics.map(
    (topic) =>
      `- [${topic.title}](${DOCS_ORIGIN}${docsPath.sdkTopicMarkdown(topic.slug)}): ${topic.summary}`,
  );
  const errorLines = documentedErrorCodes.map((code) => {
    const status = httpStatusForDocumentedCode(code);
    const prefix = status === null ? surfaceLabels[surfaceForCode(code)] : String(status);
    return `- [${code}](${DOCS_ORIGIN}${docsPath.errorCodeMarkdown(code)}): ${prefix}. ${errorDocs[code].cause}`;
  });

  return [
    "# splitch",
    "> Feature flags and A/B experimentation with agent parity: every capability a person has in the panel is available to an agent over MCP, the CLI, and the SDK. Failures are always observable and never disguised as a default.",
    "Every page below is also served as HTML at the same URL without the `.md` suffix.",
    "## Flags",
    `- [${flagsDoc.title}](${DOCS_ORIGIN}${docsPath.flagsMarkdown()}): ${flagsDoc.summary}`,
    "## SDK",
    topicLines.join("\n"),
    "## Errors",
    `Every failure code the API, SDK, and CLI can emit resolves to a page at ${DOCS_ORIGIN}/docs/error/{code}.`,
    errorLines.join("\n"),
    "## Optional",
    [
      `- [Quickstart](${DOCS_ORIGIN}/quickstart): zero to a resolving Flag with the CLI.`,
      "- [MCP server](https://mcp.splitch.dev): the same capabilities in-band for agents.",
      "- [Control Panel](https://app.splitch.dev)",
    ].join("\n"),
  ].join("\n\n");
}
