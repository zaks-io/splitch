import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checkFileSizeScript = fileURLToPath(new URL("./check-file-size.mjs", import.meta.url));
const oversizedSource = Array.from(
  { length: 301 },
  (_, index) => `export const n${index} = ${index};`,
).join("\n");

test("allows an oversized generated .gen.ts file", (t) => {
  const fixture = createStagedFixture(t, "apps/control-panel/src/routeTree.gen.ts");

  const result = runFileSizeCheck(fixture);

  assert.equal(result.status, 0, result.stderr);
});

test("rejects an oversized handwritten .ts file", (t) => {
  const fixture = createStagedFixture(t, "apps/control-panel/src/routes.ts");

  const result = runFileSizeCheck(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /routes\.ts — 301 lines/);
});

function createStagedFixture(t, relativePath) {
  const root = mkdtempSync(join(tmpdir(), "splitch-file-size-test-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));

  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, oversizedSource);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", relativePath], { cwd: root });

  return root;
}

function runFileSizeCheck(cwd) {
  return spawnSync(process.execPath, [checkFileSizeScript], {
    cwd,
    encoding: "utf8",
  });
}
