import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const CONTRACTS_SRC = "packages/contracts/src";

// Bundling with esbuild (already a root devDependency) evaluates any ref's
// contract source without a worktree, an install, or tsx. Bare imports resolve
// against HEAD's installed zod / @hono/zod-openapi, so an old ref is evaluated
// with HEAD's dependency versions.
const SNAPSHOT_ENTRY = (registryPath) => `
import { z } from "zod";
import { routeRegistry } from ${JSON.stringify(registryPath)};

export const snapshot = Object.fromEntries(
  routeRegistry.map((route) => [
    route.operationId,
    {
      method: route.method,
      path: route.path,
      input: z.toJSONSchema(route.input, { io: "input", unrepresentable: "any" }),
    },
  ]),
);
`;

/**
 * Evaluate a contracts `src` directory and return, per operationId, the route's
 * method, path, and the JSON Schema of its runtime request input
 * (`{ params, query, body }`) as a client must send it.
 */
export async function loadRequestContractSnapshot({ repoRoot, srcDir }) {
  const scratch = mkdtempSync(join(tmpdir(), "request-contract-snapshot-"));
  try {
    const result = await build({
      stdin: {
        contents: SNAPSHOT_ENTRY(join(srcDir, "route-registry.ts")),
        resolveDir: srcDir,
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      logLevel: "silent",
      nodePaths: [resolve(repoRoot, "packages/contracts/node_modules")],
    });
    const bundlePath = join(scratch, "snapshot.mjs");
    writeFileSync(bundlePath, result.outputFiles[0].text);
    const { snapshot } = await import(pathToFileURL(bundlePath).href);
    return snapshot;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function headContractsSrc(repoRoot) {
  return resolve(repoRoot, CONTRACTS_SRC);
}

/**
 * Extract `packages/contracts/src` as it was at `ref` into a temp dir. The
 * caller owns cleanup of the returned `dir`.
 */
export function extractContractsAt({ repoRoot, ref }) {
  const dir = mkdtempSync(join(tmpdir(), "request-contract-ref-"));
  const archive = spawnSync("git", ["archive", "--format=tar", ref, CONTRACTS_SRC], {
    cwd: repoRoot,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (archive.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`git archive ${ref} ${CONTRACTS_SRC} failed: ${archive.stderr}`);
  }
  const untar = spawnSync("tar", ["-x", "-C", dir], { input: archive.stdout });
  if (untar.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`extracting ${ref} contracts failed: ${untar.stderr}`);
  }
  return { dir, srcDir: join(dir, CONTRACTS_SRC) };
}
