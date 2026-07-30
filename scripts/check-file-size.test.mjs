import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checkFileSizeScript = fileURLToPath(new URL("./check-file-size.mjs", import.meta.url));

function source(lines) {
  return Array.from({ length: lines }, (_, index) => `export const n${index} = ${index};`).join(
    "\n",
  );
}

test("allows an oversized generated .gen.ts file", (t) => {
  const repo = newRepo(t);
  stage(repo, "apps/control-panel/src/routeTree.gen.ts", source(301));

  assert.equal(run(repo).status, 0);
});

test("rejects a new file that lands over the limit", (t) => {
  const repo = newRepo(t);
  stage(repo, "apps/control-panel/src/routes.ts", source(301));

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /routes\.ts — 301 lines \(crosses the 300-line limit\)/);
});

test("rejects a file this commit pushes across the limit", (t) => {
  const repo = newRepo(t);
  commit(repo, "src/grower.ts", source(299));
  stage(repo, "src/grower.ts", source(301));

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /grower\.ts — 301 lines \(crosses the 300-line limit\)/);
});

test("rejects a file that was already over the limit and grew", (t) => {
  const repo = newRepo(t);
  commit(repo, "src/barrel.ts", source(359));
  stage(repo, "src/barrel.ts", source(361));

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /barrel\.ts — 361 lines \(already over 300 at 359 lines and growing\)/,
  );
});

test("allows editing a pre-existing oversized file at the same size", (t) => {
  const repo = newRepo(t);
  commit(repo, "src/barrel.ts", source(359));
  stage(repo, "src/barrel.ts", `${source(358)}\nexport const replaced = true;`);

  assert.equal(run(repo).status, 0);
});

test("allows shrinking a pre-existing oversized file that is still over", (t) => {
  const repo = newRepo(t);
  commit(repo, "src/barrel.ts", source(359));
  stage(repo, "src/barrel.ts", source(340));

  assert.equal(run(repo).status, 0);
});

test("rejects a file moved and grown past the limit in one commit", (t) => {
  const repo = newRepo(t);
  commit(repo, "src/small.ts", source(250));
  move(repo, "src/small.ts", "src/moved/deep.ts", source(371));

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /moved\/deep\.ts — 371 lines \(crosses the 300-line limit\)/);
});

test("rejects a moved file that was already over the limit and grew", (t) => {
  const repo = newRepo(t);
  commit(repo, "src/barrel.ts", source(359));
  move(repo, "src/barrel.ts", "src/moved/barrel.ts", source(400));

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /already over 300 at 359 lines and growing/);
});

test("allows a pure move of a pre-existing oversized file", (t) => {
  const repo = newRepo(t);
  commit(repo, "src/barrel.ts", source(359));
  move(repo, "src/barrel.ts", "src/moved/barrel.ts", source(359));

  assert.equal(run(repo).status, 0);
});

test("allows a normal small file", (t) => {
  const repo = newRepo(t);
  stage(repo, "src/small.ts", source(42));

  assert.equal(run(repo).status, 0);
});

function newRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "splitch-file-size-test-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "test"], { cwd: root });
  return root;
}

function stage(repo, relativePath, contents) {
  const filePath = join(repo, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
  execFileSync("git", ["add", relativePath], { cwd: repo });
}

function commit(repo, relativePath, contents) {
  stage(repo, relativePath, contents);
  execFileSync("git", ["commit", "--quiet", "--no-verify", "-m", "baseline"], { cwd: repo });
}

/** Stage a rename, optionally changing the contents in the same commit. */
function move(repo, fromPath, toPath, contents) {
  mkdirSync(dirname(join(repo, toPath)), { recursive: true });
  execFileSync("git", ["mv", fromPath, toPath], { cwd: repo });
  writeFileSync(join(repo, toPath), contents);
  execFileSync("git", ["add", toPath], { cwd: repo });
}

function run(cwd) {
  return spawnSync(process.execPath, [checkFileSizeScript], { cwd, encoding: "utf8" });
}
