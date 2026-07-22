/**
 * Extract the canonical SDK consumer snippet from docs/spec/quickstart.md §8.
 * Consumer smoke compiles the extracted fenced block verbatim (plus minimal
 * stubs) so documentation drift fails typecheck, not just string checks.
 */
const QUICKSTART_SDK_SECTION_HEADING =
  "## 8. Start an Experiment Run, wire the SDK, and fire the first real Exposure";

/**
 * @param {string} markdown
 * @param {{ heading?: string }} [options]
 */
export function extractQuickstartSdkSnippet(markdown, options = {}) {
  const heading = options.heading ?? QUICKSTART_SDK_SECTION_HEADING;
  const sectionStart = markdown.indexOf(heading);
  if (sectionStart === -1) {
    throw new Error(`quickstart.md is missing section: ${heading}`);
  }

  const section = markdown.slice(sectionStart);
  const nextSection = section.indexOf("\n## ", heading.length);
  const sectionBody = nextSection === -1 ? section : section.slice(0, nextSection);

  const match = /```ts\n([\s\S]*?)```/.exec(sectionBody);
  if (!match?.[1]) {
    throw new Error("quickstart.md section 8 is missing a ```ts fenced SDK snippet");
  }

  return match[1].replace(/\n$/, "");
}

/**
 * @param {string} snippet
 */
export function wrapQuickstartSnippetForTypecheck(snippet) {
  return `// Auto-generated from docs/spec/quickstart.md §8 by consumer-smoke. Do not edit.
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
