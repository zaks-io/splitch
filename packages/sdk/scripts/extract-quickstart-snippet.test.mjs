import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  extractQuickstartSdkSnippet,
  stripTargetingKeyFromSnippet,
  wrapQuickstartSnippetForTypecheck,
} from "./extract-quickstart-snippet.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const quickstartPath = join(repoRoot, "docs/spec/quickstart.md");

test("extractQuickstartSdkSnippet returns the SDK section fenced block verbatim", () => {
  const markdown = readFileSync(quickstartPath, "utf8");
  const snippet = extractQuickstartSdkSnippet(markdown);

  assert.match(snippet, /^import \{ createSplitchClient \} from "@splitch\/sdk";/);
  assert.match(snippet, /clientKey: "pk_\.\.\."/);
  assert.match(snippet, /targetingKey: userId/);
  assert.doesNotMatch(snippet, /idempotencyKey/);
  assert.match(snippet, /await splitch\.evaluate\(/);
  assert.match(snippet, /await splitch\.evaluateDetails\(/);
  assert.doesNotMatch(snippet, /ck_live_/);
  assert.doesNotMatch(snippet, /ResolutionDetails/);
});

test("SDK README hello-world uses client-key get keyMaterial (pk_), not keyId", () => {
  const readme = readFileSync(join(repoRoot, "packages/sdk/README.md"), "utf8");
  assert.match(readme, /clientKey: "pk_\.\.\."/);
  assert.match(readme, /keyMaterial/);
  assert.doesNotMatch(readme, /ck_live_/);
});

test("wrapQuickstartSnippetForTypecheck preserves the extracted snippet body", () => {
  const snippet = 'import { createSplitchClient } from "@splitch/sdk";\nconst x = 1;';
  const wrapped = wrapQuickstartSnippetForTypecheck(snippet);
  assert.ok(wrapped.includes(snippet));
});

test("stripTargetingKeyFromSnippet removes required Targeting Key inputs", () => {
  const snippet = extractQuickstartSdkSnippet(readFileSync(quickstartPath, "utf8"));
  const stale = stripTargetingKeyFromSnippet(snippet);
  assert.notEqual(stale, snippet);
  assert.doesNotMatch(stale, /targetingKey/);
  assert.match(stale, /await splitch\.evaluateDetails\(/);
});
