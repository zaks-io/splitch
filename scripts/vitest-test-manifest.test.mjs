import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { defineTestFileManifest } from "./vitest-test-manifest.ts";

test("defineTestFileManifest rejects empty, duplicate, and missing entries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "splitch-test-manifest-"));
  const sourceDir = path.join(root, "src");
  const configUrl = pathToFileURL(path.join(root, "vitest.d1-tests.ts")).href;

  try {
    await mkdir(sourceDir);
    await writeFile(path.join(sourceDir, "pooled.test.ts"), "");

    assert.deepEqual(defineTestFileManifest(configUrl, ["src/pooled.test.ts"]), [
      "src/pooled.test.ts",
    ]);
    assert.throws(() => defineTestFileManifest(configUrl, []), /must not be empty/);
    assert.throws(
      () => defineTestFileManifest(configUrl, ["src/pooled.test.ts", "src/pooled.test.ts"]),
      /duplicate entries/,
    );
    assert.throws(
      () => defineTestFileManifest(configUrl, ["src/missing.test.ts"]),
      /missing files/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
