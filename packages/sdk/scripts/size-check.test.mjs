import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ENTRY_MAX_BYTES, loadEsbuild, REACT_ENTRY_MAX_BYTES } from "./size-check.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "../..");

test("ENTRY_MAX_BYTES is anchored near the measured ~18 KiB consumer bundle", () => {
  assert.equal(ENTRY_MAX_BYTES, 22 * 1024);
  assert.ok(ENTRY_MAX_BYTES > 18_024);
  assert.ok(ENTRY_MAX_BYTES < 50 * 1024);
});

test("the React entry has its own narrow budget", () => {
  assert.equal(REACT_ENTRY_MAX_BYTES, 12 * 1024);
  assert.ok(REACT_ENTRY_MAX_BYTES < ENTRY_MAX_BYTES);
});

test("loadEsbuild resolves a usable esbuild via the workspace tsup nest", async () => {
  const esbuild = await loadEsbuild();
  assert.equal(typeof esbuild.build, "function");
});

test("loadEsbuild falls through root miss to tsupRequire", async () => {
  const rootRequire = createRequire(join(repoRoot, "package.json"));
  const failingRoot = new Proxy(rootRequire, {
    apply(_target, _thisArg, args) {
      if (args[0] === "esbuild") {
        throw Object.assign(new Error("not at root"), { code: "MODULE_NOT_FOUND" });
      }
      return Reflect.apply(rootRequire, _thisArg, args);
    },
  });
  failingRoot.resolve = rootRequire.resolve.bind(rootRequire);

  const esbuild = await loadEsbuild({ rootRequire: failingRoot });
  assert.equal(typeof esbuild.build, "function");
});

test("loadEsbuild uses absolute-path import when require nests fail", async () => {
  const rootRequire = createRequire(join(repoRoot, "package.json"));
  const failingRoot = new Proxy(rootRequire, {
    apply(_target, _thisArg, args) {
      if (args[0] === "esbuild") {
        throw Object.assign(new Error("not at root"), { code: "MODULE_NOT_FOUND" });
      }
      return Reflect.apply(rootRequire, _thisArg, args);
    },
  });
  failingRoot.resolve = rootRequire.resolve.bind(rootRequire);

  let importedHref = "";
  const fakeEsbuild = { build: async () => ({}) };
  const esbuild = await loadEsbuild({
    rootRequire: failingRoot,
    tsupRequireFrom: () => {
      return () => {
        throw Object.assign(new Error("not requireable"), { code: "MODULE_NOT_FOUND" });
      };
    },
    importPath: async (href) => {
      importedHref = href;
      return fakeEsbuild;
    },
  });
  assert.equal(esbuild, fakeEsbuild);
  assert.match(importedHref, /esbuild\/lib\/main\.js$/);
});

test("loadEsbuild fails loud when every branch misses", async () => {
  await assert.rejects(
    () =>
      loadEsbuild({
        rootRequire: Object.assign(
          () => {
            throw Object.assign(new Error("no root"), { code: "MODULE_NOT_FOUND" });
          },
          {
            resolve: () => {
              throw Object.assign(new Error("no tsup"), { code: "MODULE_NOT_FOUND" });
            },
          },
        ),
      }),
    /could not resolve tsup/,
  );
});
