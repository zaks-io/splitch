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

it("never builds fault detail directly from an error stack", () => {
  const violations: string[] = [];
  for (const file of ["apps", "packages"].flatMap(workspaceSources)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node: ts.Node): void {
      if (
        (ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) &&
        node.name.getText(source).replaceAll(/["']/g, "") === "fault" &&
        node.initializer
      ) {
        function findStack(child: ts.Node): void {
          if (
            (ts.isPropertyAccessExpression(child) && child.name.text === "stack") ||
            (ts.isElementAccessExpression(child) &&
              ts.isStringLiteral(child.argumentExpression) &&
              child.argumentExpression.text === "stack")
          ) {
            violations.push(`${relative(repoRoot, file)}: use serializeFault for fault detail`);
          }
          ts.forEachChild(child, findStack);
        }
        findStack(node.initializer);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(violations).toEqual([]);
});
