#!/usr/bin/env node
/**
 * Connect-card snippet guard.
 *
 * The "Connect your code" card hands a developer a block of TypeScript and tells
 * them it works. This proves it: pack the real `@splitch/sdk` tarball, install it
 * into a throwaway consumer OUTSIDE the workspace (so no monorepo path mapping
 * can rescue a broken snippet), write exactly what the panel renders, and run
 * `tsc` against the packed public declarations.
 *
 * A negative control follows: strip `idempotencyKey` from the same snippet and
 * require `tsc` to reject it. Without that, a guard that silently stopped
 * type-checking would still report green.
 *
 * Run with `--registry` to additionally prove the displayed `npm install`
 * command resolves against the public registry (needs network).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const panelRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(panelRoot, "../..");
const sdkRoot = join(repoRoot, "packages/sdk");
const checkRegistry = process.argv.includes("--registry");

const { renderConnectSnippet, renderServerConnectSnippet, SDK_INSTALL_COMMAND } = await import(
  join(panelRoot, "src/lib/connect-snippet.ts")
);

const clientSnippet = renderConnectSnippet({
  clientKey: "pk_live_snippet_guard",
  flagKey: "new-checkout",
});
const serverSnippet = renderServerConnectSnippet({ flagKey: "new-checkout" });

if (SDK_INSTALL_COMMAND !== "npm install @splitch/sdk") {
  throw new Error(`unexpected install command on the Connect card: ${SDK_INSTALL_COMMAND}`);
}

const consumerRoot = mkdtempSync(join(tmpdir(), "splitch-connect-snippet-"));

try {
  if (!existsSync(join(sdkRoot, "dist/index.js"))) {
    throw new Error("@splitch/sdk dist is missing; run its Turbo build before the snippet check");
  }

  const packOutput = execFileSync("node", ["scripts/pack-release.mjs", consumerRoot], {
    cwd: sdkRoot,
    encoding: "utf8",
  });
  const tarballName = packOutput.trim().split("\n").at(-1);
  if (!tarballName?.endsWith(".tgz")) {
    throw new Error(`pack-release did not report a tarball path:\n${packOutput}`);
  }

  writeConsumer(consumerRoot, resolve(consumerRoot, tarballName));
  writeFileSync(join(consumerRoot, "connect-snippet.ts"), wrapForTypecheck(clientSnippet));
  writeFileSync(join(consumerRoot, "server-snippet.ts"), wrapForTypecheck(serverSnippet, true));
  writeTsconfig(consumerRoot, ["connect-snippet.ts", "server-snippet.ts"]);
  execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: consumerRoot, stdio: "inherit" });

  assertRejected(consumerRoot, clientSnippet.replace(/\n\s*idempotencyKey: evaluationId,/, ""));

  if (checkRegistry) {
    const resolved = execFileSync("npm", ["view", "@splitch/sdk", "name"], {
      encoding: "utf8",
    }).trim();
    if (resolved !== "@splitch/sdk") {
      throw new Error(`"${SDK_INSTALL_COMMAND}" does not resolve on the public registry`);
    }
    console.log(`registry check: ${SDK_INSTALL_COMMAND} resolves`);
  }

  console.log("connect snippet compiles against the packed @splitch/sdk declarations");
} finally {
  rmSync(consumerRoot, { recursive: true, force: true });
}

function writeConsumer(cwd, tarballPath) {
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify(
      { name: "splitch-connect-snippet-guard", private: true, type: "module" },
      null,
      2,
    ),
  );
  execFileSync("npm", ["install", tarballPath, "typescript@6.0.3", "zod@4.4.3"], {
    cwd,
    stdio: "inherit",
  });
}

function writeTsconfig(cwd, include) {
  writeFileSync(
    join(cwd, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          lib: ["ES2022", "DOM"],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include,
      },
      null,
      2,
    ),
  );
}

/**
 * The snippet is a fragment of a real app, so it needs module scope for its
 * top-level `await`. That is all the wrap supplies: the snippet declares its own
 * `userId`, and this must NOT declare one for it — a wrapper that fills in a
 * free variable would prove the snippet compiles somewhere the developer's
 * clipboard does not.
 */
function wrapForTypecheck(snippet, needsProcessEnv = false) {
  return [
    "export {};",
    needsProcessEnv ? "declare const process: { env: Record<string, string> };" : "",
    snippet,
    "void value;",
  ]
    .filter(Boolean)
    .join("\n");
}

function assertRejected(cwd, staleSnippet) {
  const staleRoot = mkdtempSync(join(tmpdir(), "splitch-connect-snippet-stale-"));
  try {
    writeFileSync(join(staleRoot, "package.json"), readFileSync(join(cwd, "package.json")));
    execFileSync("cp", ["-R", join(cwd, "node_modules"), join(staleRoot, "node_modules")]);
    writeFileSync(join(staleRoot, "stale-snippet.ts"), wrapForTypecheck(staleSnippet));
    writeTsconfig(staleRoot, ["stale-snippet.ts"]);
    try {
      execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: staleRoot, stdio: "pipe" });
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === 2) {
        return;
      }
      throw error;
    }
    throw new Error("snippet drift guard: tsc accepted a snippet missing idempotencyKey");
  } finally {
    rmSync(staleRoot, { recursive: true, force: true });
  }
}
