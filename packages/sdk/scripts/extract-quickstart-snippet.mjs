/**
 * Extract the canonical SDK consumer snippet from the quickstart's SDK section.
 * Consumer smoke compiles the extracted fenced block verbatim (plus minimal
 * stubs) so documentation drift fails typecheck, not just string checks.
 * The section is matched by title, not number, so renumbering the quickstart
 * cannot silently break extraction.
 */
const QUICKSTART_SDK_SECTION_TITLE =
  "Start an Experiment Run, wire the SDK, and fire the first real Exposure";
const QUICKSTART_SDK_SECTION_PATTERN = new RegExp(
  `^## \\d+\\. ${QUICKSTART_SDK_SECTION_TITLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
  "m",
);

/**
 * @param {string} markdown
 * @param {{ heading?: RegExp }} [options]
 */
export function extractQuickstartSdkSnippet(markdown, options = {}) {
  const heading = options.heading ?? QUICKSTART_SDK_SECTION_PATTERN;
  const headingMatch = heading.exec(markdown);
  if (!headingMatch) {
    throw new Error(`quickstart.md is missing section: ${heading}`);
  }

  const section = markdown.slice(headingMatch.index);
  const nextSection = section.indexOf("\n## ", headingMatch[0].length);
  const sectionBody = nextSection === -1 ? section : section.slice(0, nextSection);

  const match = /```ts\n([\s\S]*?)```/.exec(sectionBody);
  if (!match?.[1]) {
    throw new Error("quickstart.md SDK section is missing a ```ts fenced SDK snippet");
  }

  return match[1].replace(/\n$/, "");
}

/**
 * @param {string} snippet
 */
export function wrapQuickstartSnippetForTypecheck(snippet) {
  return `// Auto-generated from the docs/spec/quickstart.md SDK section by consumer-smoke. Do not edit.
declare const userId: string;
declare function renderFallback(errorCode: string | undefined): void;
declare function render(value: unknown): void;

${snippet}
`;
}

/**
 * @param {string} snippet
 */
export function stripIdempotencyKeyFromSnippet(snippet) {
  return snippet
    .replace(/\nconst evaluationId = crypto\.randomUUID\(\);[^\n]*\n/, "\n")
    .replace(/,?\n\s*idempotencyKey:\s*evaluationId/g, "");
}
