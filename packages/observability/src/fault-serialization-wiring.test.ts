import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const repoRoot = new URL("../../../", import.meta.url).pathname;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !/\.(test|spec|d)\.ts$/.test(path) ? [path] : [];
  });
}

function workspaceSources(workspace: string): string[] {
  return readdirSync(join(repoRoot, workspace), { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const directory = join(repoRoot, workspace, entry.name, "src");
    return ts.sys.directoryExists(directory) ? sourceFiles(directory) : [];
  });
}

function violationsIn(text: string, file = "fixture.ts"): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  // Public refusal contracts also use `fault` for domain codes or explanations.
  // Worker report producers, including callback-based sinks, must serialize it.
  const isWorkerReporter =
    /\b(createWorkerFaultReporter|createWorkerObservability|onFault|reduceRequestError)\b/.test(
      text,
    );
  const violations: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) &&
      node.name.getText(source).replaceAll(/["']/g, "") === "fault" &&
      node.initializer
    ) {
      const initializer = node.initializer;
      const usesSerializer =
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === "serializeFault";
      let usesStack = false;
      function findStack(child: ts.Node): void {
        if (
          (ts.isPropertyAccessExpression(child) && child.name.text === "stack") ||
          (ts.isElementAccessExpression(child) &&
            ts.isStringLiteral(child.argumentExpression) &&
            child.argumentExpression.text === "stack")
        )
          usesStack = true;
        ts.forEachChild(child, findStack);
      }
      findStack(initializer);
      if (usesStack || (isWorkerReporter && !usesSerializer)) {
        violations.push(`${relative(repoRoot, file)}: use serializeFault for fault detail`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}

it("uses shared serialization for every Worker fault producer", () => {
  const violations = ["apps", "packages"]
    .flatMap(workspaceSources)
    .flatMap((file) => violationsIn(readFileSync(file, "utf8"), file));
  expect(violations).toEqual([]);
});

it.each([
  "cause.stack ?? cause.message",
  "cause instanceof Error ? cause.message : String(cause)",
  "cause.message",
  "String(cause)",
  "JSON.stringify(cause)",
  "manualSerialize(cause)",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: source fixture for manual interpolation
  "`${cause}`",
])("rejects manual Worker fault serialization: %s", (initializer) => {
  expect(
    violationsIn(`const detail = { fault: ${initializer} }; delivery.onFault(detail, cause);`),
  ).toHaveLength(1);
  expect(
    violationsIn(
      `const fault = ${initializer}; createWorkerFaultReporter(env, options)(code, { fault });`,
    ),
  ).toHaveLength(1);
});

it("accepts shared serialization and public refusal codes", () => {
  expect(violationsIn("onFault({ fault: serializeFault(cause) }, cause);")).toEqual([]);
  expect(
    violationsIn('renderError({ details: { fault: "FLAG_CONFIGURATION_MISSING" } });'),
  ).toEqual([]);
});
