import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolvePublishedWorkspaceDependencies,
  resolveWorkspaceDependencyRange,
} from "./release/workspace-dependencies.mjs";

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "splitch-release-dependencies-"));
  mkdirSync(join(root, "packages/sdk"), { recursive: true });
  writeFileSync(
    join(root, "packages/sdk/package.json"),
    `${JSON.stringify({ name: "@splitch/sdk", version: "0.4.0" })}\n`,
  );
  return root;
}

test("resolves the workspace caret protocol to the published SDK range", () => {
  const root = fixtureRepo();
  try {
    const manifest = resolvePublishedWorkspaceDependencies(
      { dependencies: { "@splitch/sdk": "workspace:^", open: "^11.0.0" } },
      root,
    );
    assert.deepEqual(manifest.dependencies, {
      "@splitch/sdk": "^0.4.0",
      open: "^11.0.0",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects private and unsupported workspace dependency ranges", () => {
  const root = fixtureRepo();
  try {
    assert.throws(
      () => resolveWorkspaceDependencyRange("@splitch/contracts", "workspace:^", root),
      /cannot publish private workspace dependency/,
    );
    assert.throws(
      () => resolveWorkspaceDependencyRange("@splitch/sdk", "workspace:1.0.0", root),
      /unsupported workspace dependency range/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
