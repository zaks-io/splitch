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

/** `//` comment lines, plus a trailing multi-line JSDoc block. */
function comments(lines) {
  const jsdoc = ["/**", " * Why this module exists, at length.", " */"];
  const fillers = Math.max(0, lines - jsdoc.length);
  return [...Array.from({ length: fillers }, (_, index) => `// filler ${index}`), ...jsdoc].join(
    "\n",
  );
}

test("allows an oversized generated .gen.ts file", (t) => {
  const repo = newRepo(t);
  stage(repo, "apps/control-panel/src/routeTree.gen.ts", source(301));

  assert.equal(run(repo).status, 0);
});

test("allows an oversized Wrangler worker configuration declaration", (t) => {
  const repo = newRepo(t);
  stage(repo, "packages/cloudflare/src/worker-configuration.d.ts", source(301));

  assert.equal(run(repo).status, 0);
});

test("rejects a new file that lands over the limit", (t) => {
  const repo = newRepo(t);
  stage(repo, "apps/control-panel/src/routes.ts", source(301));

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /routes\.ts — 301 code lines \(crosses the 300 code-line limit\)/);
});

test("rejects a file this commit pushes across the limit", (t) => {
  const repo = newRepo(t);
  commit(repo, "src/grower.ts", source(299));
  stage(repo, "src/grower.ts", source(301));

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /grower\.ts — 301 code lines \(crosses the 300 code-line limit\)/);
});

test("rejects a file that was already over the limit and grew", (t) => {
  const repo = newRepo(t);
  commit(repo, "src/barrel.ts", source(359));
  stage(repo, "src/barrel.ts", source(361));

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /barrel\.ts — 361 code lines \(already over the 300 code-line limit at 359 and growing\)/,
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
  assert.match(
    result.stderr,
    /moved\/deep\.ts — 371 code lines \(crosses the 300 code-line limit\)/,
  );
});

test("rejects a moved file that was already over the limit and grew", (t) => {
  const repo = newRepo(t);
  commit(repo, "src/barrel.ts", source(359));
  move(repo, "src/barrel.ts", "src/moved/barrel.ts", source(400));

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /already over the 300 code-line limit at 359 and growing/);
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

test("comment and blank lines are free: heavy docs over 300 raw lines pass", (t) => {
  const repo = newRepo(t);
  stage(repo, "src/documented.ts", `${comments(240)}\n\n${source(250)}`);

  assert.equal(run(repo).status, 0);
});

test("a line with trailing comment still counts as code", (t) => {
  const repo = newRepo(t);
  const trailing = Array.from({ length: 301 }, (_, i) => `export const n${i} = ${i}; // doc`).join(
    "\n",
  );
  stage(repo, "src/trailing.ts", trailing);

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /trailing\.ts — 301 code lines \(crosses the 300 code-line limit\)/);
});

test("rejects a file whose comments push it past the total-line cap", (t) => {
  const repo = newRepo(t);
  stage(repo, "src/dense.ts", `${comments(450)}\n${source(200)}`);

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /dense\.ts — 650 total lines \(crosses the 600 total-line limit\)/);
});

test("rejects comment growth on a file already over the total cap", (t) => {
  const repo = newRepo(t);
  commit(repo, "src/dense.ts", `${comments(450)}\n${source(200)}`);
  stage(repo, "src/dense.ts", `${comments(460)}\n${source(200)}`);

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /dense\.ts — 660 total lines \(already over the 600 total-line limit at 650 and growing\)/,
  );
});

test("allows trimming comments on a file still over the total cap", (t) => {
  const repo = newRepo(t);
  commit(repo, "src/dense.ts", `${comments(450)}\n${source(200)}`);
  stage(repo, "src/dense.ts", `${comments(440)}\n${source(200)}`);

  assert.equal(run(repo).status, 0);
});

test("reports both metrics when a file trips code limit and total cap", (t) => {
  const repo = newRepo(t);
  stage(repo, "src/huge.ts", `${comments(300)}\n${source(301)}`);

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /huge\.ts — 301 code lines/);
  assert.match(result.stderr, /huge\.ts — 601 total lines/);
});

test("allows a merge whose resolution matches the other parent's growth", (t) => {
  const repo = newRepo(t);
  commit(repo, "src/barrel.ts", source(320));
  const main = currentBranch(repo);
  branch(repo, "feature");
  commit(repo, "src/barrel.ts", source(360));
  checkout(repo, main);
  commit(repo, "src/other.ts", source(10));
  merge(repo, "feature");

  assert.equal(run(repo).status, 0);
});

test("allows an octopus merge whose growth came from the third parent", (t) => {
  const repo = newRepo(t);
  commit(repo, "src/barrel.ts", source(320));
  const main = currentBranch(repo);
  branch(repo, "feature-a");
  commit(repo, "src/a.ts", source(10));
  checkout(repo, main);
  branch(repo, "feature-b");
  commit(repo, "src/barrel.ts", source(360));
  checkout(repo, main);
  commit(repo, "src/other.ts", source(10));
  merge(repo, "feature-a", "feature-b");

  assert.equal(run(repo).status, 0);
});

test("rejects a merge resolution larger than both parents", (t) => {
  const repo = newRepo(t);
  commit(repo, "src/barrel.ts", source(320));
  const main = currentBranch(repo);
  branch(repo, "feature");
  commit(repo, "src/barrel.ts", source(360));
  checkout(repo, main);
  commit(repo, "src/barrel.ts", source(340));
  merge(repo, "feature");
  stage(repo, "src/barrel.ts", source(380));

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /barrel\.ts — 380 code lines \(already over the 300 code-line limit at 360 and growing\)/,
  );
});

test("rejects a merge resolution that crosses the limit neither parent was over", (t) => {
  const repo = newRepo(t);
  commit(repo, "src/barrel.ts", source(250));
  const main = currentBranch(repo);
  branch(repo, "feature");
  commit(repo, "src/barrel.ts", source(280));
  checkout(repo, main);
  commit(repo, "src/barrel.ts", source(260));
  merge(repo, "feature");
  stage(repo, "src/barrel.ts", source(301));

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /barrel\.ts — 301 code lines \(crosses the 300 code-line limit\)/);
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

function currentBranch(repo) {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
}

function branch(repo, name) {
  execFileSync("git", ["checkout", "--quiet", "-b", name], { cwd: repo });
}

function checkout(repo, name) {
  execFileSync("git", ["checkout", "--quiet", name], { cwd: repo });
}

/** Start a real merge and stop before the commit, so MERGE_HEAD is live. */
function merge(repo, ...refs) {
  spawnSync("git", ["merge", "--quiet", "--no-commit", "--no-ff", ...refs], { cwd: repo });
}

function run(cwd) {
  return spawnSync(process.execPath, [checkFileSizeScript], { cwd, encoding: "utf8" });
}
