import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  extractQuickstartSdkSnippet,
  stripIdempotencyKeyFromSnippet,
  wrapQuickstartSnippetForTypecheck,
} from "./extract-quickstart-snippet.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const quickstartPath = join(repoRoot, "docs/spec/quickstart.md");

test("extractQuickstartSdkSnippet returns the SDK section fenced block verbatim", () => {
  const markdown = readFileSync(quickstartPath, "utf8");
  const snippet = extractQuickstartSdkSnippet(markdown);

  assert.match(snippet, /^import \{ createSplitchClient \} from "@splitch\/sdk";/);
  assert.match(snippet, /idempotencyKey: evaluationId/);
  assert.match(snippet, /await splitch\.evaluate\(/);
  assert.match(snippet, /await splitch\.evaluateDetails\(/);
  assert.doesNotMatch(snippet, /ResolutionDetails/);
});

test("wrapQuickstartSnippetForTypecheck preserves the extracted snippet body", () => {
  const snippet = 'import { createSplitchClient } from "@splitch/sdk";\nconst x = 1;';
  const wrapped = wrapQuickstartSnippetForTypecheck(snippet);
  assert.ok(wrapped.includes(snippet));
});

test("stripIdempotencyKeyFromSnippet removes required idempotency inputs", () => {
  const snippet = extractQuickstartSdkSnippet(readFileSync(quickstartPath, "utf8"));
  const stale = stripIdempotencyKeyFromSnippet(snippet);
  assert.doesNotMatch(stale, /idempotencyKey/);
  assert.doesNotMatch(stale, /evaluationId/);
});
