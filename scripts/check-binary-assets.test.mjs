import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checkBinaryAssetsScript = fileURLToPath(
  new URL("./check-binary-assets.mjs", import.meta.url),
);

test("rejects a screenshot committed under docs/", (t) => {
  const repo = newRepo(t);
  stage(repo, "docs/review/panel.png", "PNG");

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/review\/panel\.png/);
});

test("rejects a raster anywhere else under an app's public directory", (t) => {
  const repo = newRepo(t);
  stage(repo, "apps/marketing/public/screenshots/hero.png", "PNG");

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /apps\/marketing\/public\/screenshots\/hero\.png/);
});

test("rejects a raster beside an allowlisted brand icon", (t) => {
  const repo = newRepo(t);
  stage(repo, "assets/brand/moodboard.png", "PNG");

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /assets\/brand\/moodboard\.png/);
});

test("rejects rasters the guard never allowed, by extension", (t) => {
  for (const path of ["shot.jpg", "shot.jpeg", "shot.gif", "a.webp", "a.avif", "a.bmp", "a.ico"]) {
    const repo = newRepo(t);
    stage(repo, path, "binary");

    assert.equal(run(repo).status, 1, path);
  }
});

test("allows the brand master and every icon it generates", (t) => {
  const repo = newRepo(t);
  for (const path of [
    "assets/brand/splitch-mark.png",
    "apps/marketing/public/favicon.ico",
    "apps/marketing/public/apple-touch-icon.png",
    "apps/marketing/public/brand/splitch-mark.png",
    "apps/marketing/public/icon-192.png",
    "apps/marketing/public/icon-512.png",
    "apps/marketing/public/icon-maskable-512.png",
    "apps/marketing/public/og-card.png",
    "apps/control-panel/public/favicon.ico",
    "apps/control-panel/public/apple-touch-icon.png",
    "apps/control-panel/public/brand/splitch-mark.png",
    "apps/control-panel/public/icon-192.png",
    "apps/control-panel/public/icon-512.png",
    "apps/control-panel/public/icon-maskable-512.png",
  ]) {
    stage(repo, path, "PNG");
  }

  assert.equal(run(repo).status, 0);
});

test("does not allow a social card in the panel, which is never unfurled", (t) => {
  const repo = newRepo(t);
  stage(repo, "apps/control-panel/public/og-card.png", "PNG");

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /apps\/control-panel\/public\/og-card\.png/);
});

test("allows source vectors", (t) => {
  const repo = newRepo(t);
  stage(repo, "packages/ui/src/diagram.svg", "<svg />");

  assert.equal(run(repo).status, 0);
});

test("ignores an allowlisted path that only appears as a suffix", (t) => {
  const repo = newRepo(t);
  stage(repo, "vendor/assets/brand/splitch-mark.png", "PNG");

  const result = run(repo);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /vendor\/assets\/brand\/splitch-mark\.png/);
});

function newRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "splitch-binary-assets-test-"));
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

function run(cwd) {
  return spawnSync(process.execPath, [checkBinaryAssetsScript], { cwd, encoding: "utf8" });
}
