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
 * Remove `targetingKey: userId` from evaluate/evaluateDetails object literals
 * while keeping the remaining object syntactically valid. Neighboring optional
 * fields such as `idempotencyKey` are left untouched.
 *
 * @param {string} snippet
 */
export function stripTargetingKeyFromSnippet(snippet) {
  return snippet.replace(/(,\s*)?targetingKey:\s*userId\b(\s*,)?/g, replaceTargetingKeyProperty);
}

/**
 * @param {string} _match
 * @param {string | undefined} leadingComma
 * @param {string | undefined} trailingComma
 */
function replaceTargetingKeyProperty(_match, leadingComma, trailingComma) {
  return leadingComma && trailingComma ? "," : "";
}

const MISSING_TARGETING_KEY_DIAGNOSTIC = /Property ['"]targetingKey['"] is missing/;
const OBJECT_LITERAL_SYNTAX_ERROR = /\berror TS(?:1005|1109|1135|1136):/;

/**
 * The packed-consumer negative control must fail because `targetingKey` is
 * required, not because the stale snippet is a syntax error. Empty output
 * (TypeScript succeeded) is the optional-`targetingKey` mutation: the guard
 * must fail rather than treat success as a pass.
 *
 * @param {string} tscOutput
 * @param {string} label
 */
export function assertMissingTargetingKeyDiagnostic(tscOutput, label) {
  if (OBJECT_LITERAL_SYNTAX_ERROR.test(tscOutput)) {
    throw new Error(
      `${label}: TypeScript rejected the stale snippet as a syntax error, not a missing targetingKey:\n${tscOutput}`,
    );
  }
  if (!MISSING_TARGETING_KEY_DIAGNOSTIC.test(tscOutput)) {
    throw new Error(
      `${label}: TypeScript did not report the required targetingKey as missing:\n${tscOutput || "(empty output)"}`,
    );
  }
}
