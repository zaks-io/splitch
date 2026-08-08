#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
/**
 * Per-entry browser bundle size gate (SPL-325).
 *
 * Bundles a minimal consumer page against each published export entry with
 * esbuild `--bundle --format=esm --minify`, then asserts total bytes under
 * ENTRY_MAX_BYTES.
 *
 * Budgets are per entry (`.`, and later `./browser`) so a future browser
 * subpath starts life inside the gate rather than inheriting a package-wide
 * allowance.
 *
 * A reintroduced zod that is inlined into dist (via `external: []`) will not
 * appear as a metafile `node_modules/zod` path — the packed-manifest zero-dep
 * check is the load-bearing zod guard; this budget is what catches inlined
 * source by size. The metafile scan below is only a secondary signal for
 * accidental re-externalization.
 */
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");

/**
 * Minified consumer+SDK budget per published entry.
 * Measured 18_024 bytes for `.` at SPL-325; that figure is toolchain-dependent
 * (it moves with the bundle contents and the esbuild version).
 * `size-check.test.mjs` documents the floor (`ENTRY_MAX_BYTES > 18_024`) rather
 * than gating on the exact measurement. Ceiling is 22 KiB (~25% headroom over
 * that figure) for intentional SDK growth (new accessors / wire fields) short
 * of re-vendoring zod (~300 KiB), which this budget alone is meant to reject.
 */
export const ENTRY_MAX_BYTES = 22 * 1024;

/**
 * Resolve esbuild from the workspace (tsup nests it). Prefer a direct
 * `esbuild` install when present; otherwise walk tsup's nested dependency.
 *
 * @param {{ rootRequire?: NodeRequire, tsupRequireFrom?: (tsupPkg: string) => NodeRequire, importPath?: (href: string) => Promise<unknown> }} [deps]
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: three explicit resolution fallbacks for pnpm layout
export async function loadEsbuild(deps = {}) {
  const rootRequire = deps.rootRequire ?? createRequire(join(repoRoot, "package.json"));
  try {
    return rootRequire("esbuild");
  } catch {
    // fall through to tsup
  }

  let tsupPkg;
  try {
    tsupPkg = rootRequire.resolve("tsup/package.json");
  } catch (error) {
    throw new Error(
      `size:check could not resolve tsup (needed to locate nested esbuild): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const tsupRequire = (deps.tsupRequireFrom ?? createRequire)(tsupPkg);
  try {
    return tsupRequire("esbuild");
  } catch {
    // fall through to absolute path
  }

  // pnpm may nest esbuild under tsup's node_modules without making it
  // require()-able from tsup's package root; load by absolute path.
  const nested = join(dirname(tsupPkg), "node_modules", "esbuild", "lib", "main.js");
  const importPath = deps.importPath ?? ((href) => import(href));
  try {
    return await importPath(pathToFileURL(nested).href);
  } catch (error) {
    throw new Error(
      `size:check could not load esbuild (install it at the workspace root or ensure tsup's nested esbuild is present): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function publishedEntries(manifest) {
  const exportsField = manifest.exports;
  if (!exportsField || typeof exportsField !== "object") {
    throw new Error("size:check requires package.json exports");
  }
  const entries = [];
  for (const [exportPath, target] of Object.entries(exportsField)) {
    if (!target || typeof target !== "object" || typeof target.import !== "string") {
      continue;
    }
    const relative = target.import.replace(/^\.\//, "");
    entries.push({
      exportPath,
      distFile: join(packageRoot, relative),
      importSpecifier:
        exportPath === "." ? "@splitch/sdk" : `@splitch/sdk/${exportPath.replace(/^\.\//, "")}`,
    });
  }
  if (entries.length === 0) {
    throw new Error("size:check found no importable package exports");
  }
  return entries;
}

function assertNoZodInMetafile(metafile, exportPath) {
  // Secondary only: with external:[] zod is inlined into dist before this
  // consumer bundle runs, so node_modules/zod paths never appear. Real guard
  // is assertZeroRuntimeDependencies + ENTRY_MAX_BYTES.
  const inputs = Object.keys(metafile.inputs ?? {});
  const zodInputs = inputs.filter(
    (path) =>
      path.includes("node_modules/zod") || path.includes("zod/v4/locales") || /\/zod\//.test(path),
  );
  if (zodInputs.length > 0) {
    throw new Error(
      `size:check ${exportPath}: consumer bundle pulled zod modules:\n${zodInputs.slice(0, 20).join("\n")}`,
    );
  }
}

async function measureEntry(esbuild, entry) {
  const staging = mkdtempSync(join(tmpdir(), "splitch-sdk-size-"));
  try {
    const appPath = join(staging, "app.js");
    // Minimal page shape from SPL-325: createSplitchClient + evaluateDetails + verify.
    writeFileSync(
      appPath,
      `import { createSplitchClient } from ${JSON.stringify(entry.importSpecifier)};
const client = createSplitchClient({ clientKey: "ck_size" });
await client.evaluateDetails("flag", { targetingKey: "u", idempotencyKey: "k", defaultValue: false });
await client.verify("flag", { targetingKey: "u", defaultValue: false });
`,
    );

    const outfile = join(staging, "out.js");
    const result = await esbuild.build({
      absWorkingDir: staging,
      entryPoints: [appPath],
      outfile,
      bundle: true,
      format: "esm",
      minify: true,
      platform: "browser",
      target: ["es2022"],
      write: true,
      metafile: true,
      logLevel: "silent",
      plugins: [
        {
          name: "resolve-splitch-sdk-dist",
          setup(build) {
            build.onResolve({ filter: /^@splitch\/sdk(\/.*)?$/ }, (args) => {
              if (args.path === entry.importSpecifier) {
                return { path: entry.distFile };
              }
              return null;
            });
          },
        },
      ],
    });

    const bytes = Buffer.byteLength(readFileSync(outfile));
    assertNoZodInMetafile(result.metafile, entry.exportPath);
    if (bytes > ENTRY_MAX_BYTES) {
      throw new Error(
        `size:check ${entry.exportPath}: minified consumer bundle is ${bytes} bytes (max ${ENTRY_MAX_BYTES})`,
      );
    }
    return bytes;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function runSizeCheck({
  loadEsbuildFn = loadEsbuild,
  manifestPath = join(packageRoot, "package.json"),
} = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
    throw new Error(
      `size:check: package.json must have zero dependencies; got ${Object.keys(manifest.dependencies).join(", ")}`,
    );
  }

  const esbuild = await loadEsbuildFn();
  const entries = publishedEntries(manifest);

  for (const entry of entries) {
    try {
      readFileSync(entry.distFile);
    } catch {
      throw new Error(`size:check missing built entry ${entry.distFile}; run build first`);
    }
    const bytes = await measureEntry(esbuild, entry);
    console.log(`size:check ${entry.exportPath}: ${bytes} bytes (max ${ENTRY_MAX_BYTES})`);
  }

  console.log("size:check passed");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  await runSizeCheck();
}
