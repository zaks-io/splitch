import assert from "node:assert/strict";
import test from "node:test";
import { scriptHasUnpinnedInstall } from "./lib/privileged-toolchain-install.mjs";

const empty = { env: {}, inputs: {} };

test("npm flag-before-verb, wrappers, and pipelines are still exact-version gated", () => {
  assert.equal(unpinned("npm --global install npm@11"), true);
  assert.equal(unpinned("sudo npm install --global npm@11"), true);
  assert.equal(unpinned("PREFIX=/usr npm install --global npm@11"), true);
  assert.equal(unpinned("env FOO=bar npm install --global npm@11"), true);
  assert.equal(unpinned("echo ready | npm install --global npm@11"), true);
  assert.equal(unpinned("sudo env PREFIX=/usr npm --global install npm@11.15.0"), false);
});

test("pip, uv, and cargo global options do not hide an unpinned install", () => {
  assert.equal(unpinned("pip --user install requests"), true);
  assert.equal(unpinned("python3 -m pip --user install requests"), true);
  assert.equal(unpinned("uv --offline tool install tinybird"), true);
  assert.equal(unpinned("cargo --locked install ripgrep"), true);
  assert.equal(unpinned("pip install requests==2.32.3"), false);
  assert.equal(unpinned("uv tool install tinybird==4.6.14"), false);
  assert.equal(unpinned("cargo install --version 14.1.1 ripgrep"), false);
});

test("every cargo crate argument must be exact; mixed commands fail", () => {
  assert.equal(unpinned("cargo install ripgrep@14.1.1"), false);
  assert.equal(unpinned("cargo install ripgrep@14.1.1 fd-find"), true);
  assert.equal(unpinned("cargo install ripgrep@14.1.1 fd-find@10.2.0"), false);
});

test("unparseable installer shapes fail closed", () => {
  assert.equal(unpinned("eval npm install npm@11.15.0"), true);
  assert.equal(unpinned("xargs npm install npm@11.15.0"), true);
  assert.equal(unpinned("npm $ACTION npm@11.15.0"), true);
  assert.equal(unpinned('n"p"m install --global npm@11'), true);
  assert.equal(unpinned('sh -c "npm install --global npm@11"'), true);
  assert.equal(unpinned('eval "npm install --global npm@11"'), true);
});

test("zero-package installs require an immutable lock mode", () => {
  assert.equal(unpinned("npm install"), true);
  assert.equal(unpinned("npm i"), true);
  assert.equal(unpinned("pnpm install"), true);
  assert.equal(unpinned("pnpm install --frozen-lockfile"), false);
  assert.equal(unpinned("npm ci"), false);
  assert.equal(unpinned("yarn install --immutable"), false);
});

test("non-install npm/pnpm/uv commands are not treated as floating installs", () => {
  assert.equal(unpinned("npm --version"), false);
  assert.equal(unpinned("pnpm --filter @splitch/sdk build"), false);
  assert.equal(unpinned("pnpm exec playwright install --with-deps chromium"), false);
  assert.equal(unpinned("pnpm install --frozen-lockfile"), false);
  assert.equal(unpinned("uv --version"), false);
});

test("resolved env bindings still allow exact npm pins", () => {
  assert.equal(
    scriptHasUnpinnedInstall('npm install --global "npm@$' + '{NPM_VERSION}"', {
      env: { NPM_VERSION: "11.15.0" },
      inputs: {},
    }),
    false,
  );
});

function unpinned(script) {
  return scriptHasUnpinnedInstall(script, empty);
}
