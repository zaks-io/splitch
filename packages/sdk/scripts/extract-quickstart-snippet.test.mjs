import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertMissingTargetingKeyDiagnostic,
  extractQuickstartSdkSnippet,
  stripTargetingKeyFromSnippet,
  wrapQuickstartSnippetForTypecheck,
} from "./extract-quickstart-snippet.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const quickstartPath = join(repoRoot, "docs/spec/quickstart.md");
const tscBin = join(repoRoot, "node_modules/.bin/tsc");

const EVALUATE_ONLY = `const variant = await splitch.evaluate("flag", {
  targetingKey: userId,
});`;

const EVALUATE_DETAILS_ONLY = `const d = await splitch.evaluateDetails("flag", {
  targetingKey: userId,
});`;

const EVALUATE_WITH_IDEMPOTENCY = `const variant = await splitch.evaluate("flag", {
  targetingKey: userId,
  idempotencyKey: retryKey,
});`;

function assertValidJsSyntax(source) {
  const body = source.replace(/^import\s+[\s\S]*?;\s*/m, "");
  try {
    new Function(
      "splitch",
      "userId",
      "retryKey",
      "renderFallback",
      "render",
      `return (async () => {\n${body}\n});`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    assert.fail(`stripped snippet is not valid JavaScript: ${detail}\n${source}`);
  }
}

function assertStrippedEvaluateShape(source, method) {
  const stale = stripTargetingKeyFromSnippet(source);
  assert.notEqual(stale, source);
  assert.doesNotMatch(stale, /targetingKey/);
  assert.doesNotMatch(stale, /\{\s*,/);
  assert.match(stale, new RegExp(`await splitch\\.${method}\\(`));
  assertValidJsSyntax(stale);
  return stale;
}

/**
 * @param {string} snippet
 * @param {string} contextFields
 */
function writeContextFixture(dir, snippet, contextFields) {
  writeFileSync(
    join(dir, "snippet.ts"),
    `interface EvaluationContext {
  ${contextFields}
}
declare const splitch: {
  evaluate(flagKey: string, context: EvaluationContext): Promise<unknown>;
  evaluateDetails(flagKey: string, context: EvaluationContext): Promise<{ reason: string; errorCode?: string; value: unknown }>;
};
declare const userId: string;
declare const retryKey: string;
declare function renderFallback(errorCode: string | undefined): void;
declare function render(value: unknown): void;
${snippet.replace(/^import\s+[\s\S]*?;\s*/m, "")}
`,
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "splitch-stale-snippet", private: true, type: "module" }),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["snippet.ts"],
    }),
  );
}

/**
 * @param {unknown} error
 */
function tscFailureResult(error) {
  const status = error instanceof Error && "status" in error ? Number(error.status) : 1;
  const output = `${error instanceof Error && "stdout" in error ? error.stdout : ""}${
    error instanceof Error && "stderr" in error ? error.stderr : ""
  }`;
  return { status, output };
}

/**
 * @param {string} snippet
 * @param {string} contextFields
 */
function typecheckAgainstContext(snippet, contextFields) {
  const dir = mkdtempSync(join(tmpdir(), "splitch-stale-snippet-"));
  try {
    writeContextFixture(dir, snippet, contextFields);
    execFileSync(tscBin, ["-p", "tsconfig.json"], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { status: 0, output: "" };
  } catch (error) {
    return tscFailureResult(error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
  const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
  assert.match(readme, /clientKey: "pk_\.\.\."/);
  assert.match(readme, /keyMaterial/);
  assert.doesNotMatch(readme, /ck_live_/);
});

test("wrapQuickstartSnippetForTypecheck preserves the extracted snippet body", () => {
  const snippet = 'import { createSplitchClient } from "@splitch/sdk";\nconst x = 1;';
  const wrapped = wrapQuickstartSnippetForTypecheck(snippet);
  assert.ok(wrapped.includes(snippet));
});

test("stripTargetingKeyFromSnippet keeps evaluate() syntactically valid", () => {
  const stale = assertStrippedEvaluateShape(EVALUATE_ONLY, "evaluate");
  assert.match(stale, /evaluate\("flag", \{\s*\}\)/);
});

test("stripTargetingKeyFromSnippet keeps evaluateDetails() syntactically valid", () => {
  const stale = assertStrippedEvaluateShape(EVALUATE_DETAILS_ONLY, "evaluateDetails");
  assert.match(stale, /evaluateDetails\("flag", \{\s*\}\)/);
});

test("stripTargetingKeyFromSnippet preserves optional idempotencyKey neighbors", () => {
  const stale = assertStrippedEvaluateShape(EVALUATE_WITH_IDEMPOTENCY, "evaluate");
  assert.match(stale, /idempotencyKey: retryKey/);
});

test("stripTargetingKeyFromSnippet removes Targeting Key from the extracted quickstart snippet", () => {
  const snippet = extractQuickstartSdkSnippet(readFileSync(quickstartPath, "utf8"));
  const stale = assertStrippedEvaluateShape(snippet, "evaluate");
  assert.match(stale, /await splitch\.evaluateDetails\(/);
});

test("assertMissingTargetingKeyDiagnostic accepts the required-property diagnostic", () => {
  assert.doesNotThrow(() =>
    assertMissingTargetingKeyDiagnostic(
      "error TS2345: Argument of type '{}' is not assignable to parameter of type 'EvaluationContext'.\n  Property 'targetingKey' is missing in type '{}' but required in type 'EvaluationContext'.",
      "required",
    ),
  );
});

test("assertMissingTargetingKeyDiagnostic rejects syntax errors and optional-key success", () => {
  assert.throws(
    () => assertMissingTargetingKeyDiagnostic("error TS1005: ',' expected.", "syntax"),
    /syntax error, not a missing targetingKey/,
  );
  assert.throws(
    () => assertMissingTargetingKeyDiagnostic("", "optional targetingKey mutation"),
    /did not report the required targetingKey/,
  );
});

test("stale evaluate/evaluateDetails fail only while targetingKey is required", () => {
  const snippet = `${EVALUATE_ONLY}\n${EVALUATE_DETAILS_ONLY}`;
  const stale = stripTargetingKeyFromSnippet(snippet);
  const required = typecheckAgainstContext(
    stale,
    "readonly targetingKey: string; readonly idempotencyKey?: string;",
  );
  assert.equal(required.status, 2, required.output);
  assertMissingTargetingKeyDiagnostic(required.output, "required targetingKey");

  const optional = typecheckAgainstContext(
    stale,
    "readonly targetingKey?: string; readonly idempotencyKey?: string;",
  );
  assert.equal(optional.status, 0, optional.output);
  assert.throws(
    () => assertMissingTargetingKeyDiagnostic(optional.output, "optional targetingKey mutation"),
    /did not report the required targetingKey/,
  );
});
