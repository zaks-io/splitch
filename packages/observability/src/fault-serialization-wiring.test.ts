import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { unsafeFaultLogs } from "./test-support/fault-log-wiring";
import { reportedFaultRethrows, unsafeStackWrites } from "./test-support/fault-runtime-wiring";
import { sourceFiles } from "./test-support/workspace-sources";

const repoRoot = new URL("../../../", import.meta.url).pathname;

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

it("preserves engine stack trust throughout application and package source", () => {
  const violations = ["apps", "packages"]
    .flatMap((workspace) => sourceFiles(join(repoRoot, workspace)))
    .flatMap((file) => guardViolations(file, unsafeStackWrites));
  expect(violations).toEqual([]);
});

it("does not rethrow reported faults into the Worker runtime", () => {
  const violations = ["control-plane-api", "event-ingest-api", "mcp-server"]
    .flatMap((app) => sourceFiles(join(repoRoot, "apps", app, "src")))
    .flatMap((file) => guardViolations(file, reportedFaultRethrows));
  expect(violations).toEqual([]);
});

function guardViolations(file: string, guard: (source: ts.SourceFile) => number[]): string[] {
  return guard(
    ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true),
  ).map((line) => `${relative(repoRoot, file)}:${line}`);
}

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

it("serializes caught errors at every Control Plane and Event Ingest log boundary", () => {
  const violations = ["control-plane-api", "event-ingest-api"]
    .flatMap((app) => sourceFiles(join(repoRoot, "apps", app, "src")))
    .flatMap((file) =>
      unsafeFaultLogs(
        ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true),
      ).map((line) => `${relative(repoRoot, file)}:${line}`),
    );
  expect(violations).toEqual([]);
});

it.each([
  "console.error(error)",
  "logger.warn({ cause: error })",
  "deps.logger?.error(error.message)",
  "(deps.logger ?? console).error(error.stack)",
  "const alias = deps.logger; alias.warn({ cause: error.cause })",
  "const write = console.error.bind(console); write(error)",
  "const { warn: write } = logger; write(error)",
  "const payload = { cause: error }; const output = payload; logger.error(output)",
  "const detail = error.message; logger.info(detail)",
  "let sink; sink = console.warn; let detail; detail = error; sink(detail)",
])("rejects raw errors through logger aliases: %s", (body) => {
  const source = ts.createSourceFile(
    "fixture.ts",
    `try {} catch (error) { ${body}; }`,
    ts.ScriptTarget.Latest,
    true,
  );
  expect(unsafeFaultLogs(source).length).toBeGreaterThan(0);
});

it("rejects raw errors through an imported logger alias", () => {
  const source = ts.createSourceFile(
    "fixture.ts",
    'import { logger as output } from "./logging"; try {} catch (err) { output.warn(err); }',
    ts.ScriptTarget.Latest,
    true,
  );
  expect(unsafeFaultLogs(source)).toHaveLength(1);
});

it("accepts serialized error aliases and ordinary log metadata", () => {
  const source = ts.createSourceFile(
    "fixture.ts",
    `
    import { serializeFault as safeFault } from "@splitch/observability/worker";
    try {} catch (error) {
      const detail = safeFault(error);
      const write = console.error.bind(console);
      write({ fault: detail });
      logger.warn({ cause: serializeFault(error) });
      console.info({ requestId: "request" });
    }
  `,
    ts.ScriptTarget.Latest,
    true,
  );
  expect(unsafeFaultLogs(source)).toEqual([]);
});
