import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./install-git-hooks.mjs", import.meta.url));
const lefthookBin = fileURLToPath(new URL("../node_modules/.bin", import.meta.url));

test("installs lefthook when nothing owns core.hooksPath", (t) => {
  const repo = newRepo(t);

  const result = run(repo);

  assert.equal(result.status, 0);
  assert.ok(hooks(join(repo, ".git", "hooks")).includes("pre-commit"));
});

test("yields the hooks and says so when a local core.hooksPath owns them", (t) => {
  const repo = newRepo(t);
  mkdirSync(join(repo, "agent-hooks"));
  git(repo, ["config", "core.hooksPath", "agent-hooks"]);

  const result = run(repo);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /core\.hooksPath is set in local config to agent-hooks/);
  assert.match(result.stderr, /lefthook was NOT installed/);
  assert.match(result.stderr, /--reset-hooks-path/);
  assert.deepEqual(hooks(join(repo, "agent-hooks")), []);
  assert.deepEqual(hooks(join(repo, ".git", "hooks")), []);
});

test("leaves a globally-configured hooks path in place", (t) => {
  const repo = newRepo(t);
  const home = mkdtempSync(join(tmpdir(), "install-git-hooks-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const hooksPath = join(home, ".cursor", "agent-hooks");
  mkdirSync(hooksPath, { recursive: true });
  writeFileSync(join(home, ".gitconfig"), `[core]\n\thooksPath = ${hooksPath}\n`);

  const result = run(repo, { HOME: home });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /core\.hooksPath is set in global config/);
  assert.equal(
    execFileSync("git", ["config", "--global", "--get", "core.hooksPath"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    }).trim(),
    hooksPath,
  );
  assert.deepEqual(hooks(hooksPath), []);
});

test("prepare runs this script instead of lefthook install directly", () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  );

  assert.equal(manifest.scripts.prepare, "node scripts/install-git-hooks.mjs");
});

function newRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), "install-git-hooks-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ["init", "--quiet", "."]);
  writeFileSync(
    join(repo, "lefthook.yml"),
    "pre-commit:\n  commands:\n    noop:\n      run: true\n",
  );
  return repo;
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function hooks(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => entry.name)
    .filter((name) => !name.endsWith(".sample"));
}

function run(cwd, env = {}) {
  return spawnSync(process.execPath, [script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env, PATH: `${lefthookBin}:${process.env.PATH}` },
  });
}
