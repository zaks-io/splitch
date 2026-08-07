#!/usr/bin/env node
/**
 * Consumer smoke: install the packed SDK tarball outside the monorepo workspace
 * and verify ESM runtime import, TypeScript declaration resolution, and the
 * exact docs/spec/quickstart.md SDK-section fenced snippet against packed public
 * declarations.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBuildStamp } from "../../../scripts/release/build-stamp.mjs";
import {
  extractQuickstartSdkSnippet,
  stripIdempotencyKeyFromSnippet,
  wrapQuickstartSnippetForTypecheck,
} from "./extract-quickstart-snippet.mjs";
import { assertReleaseBundleJs } from "./pack-staging.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const quickstartPath = join(repoRoot, "docs/spec/quickstart.md");
const consumerRoot = mkdtempSync(join(tmpdir(), "splitch-sdk-consumer-"));

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd ?? consumerRoot,
    stdio: options.stdio ?? "inherit",
    env: {
      ...process.env,
      npm_config_cache: join(consumerRoot, ".npm-cache"),
      ...options.env,
    },
  });
}

function runTypecheck(cwd = consumerRoot) {
  run("npx", ["tsc", "-p", "tsconfig.json"], { cwd });
}

function expectTypecheckFailure(cwd, label) {
  try {
    execFileSync("npx", ["tsc", "-p", "tsconfig.json"], {
      cwd,
      stdio: "pipe",
      encoding: "utf8",
    });
    throw new Error(`${label}: expected TypeScript to reject the stale snippet`);
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 2) {
      return;
    }
    throw error;
  }
}

function writeConsumerTsconfig(include, cwd = consumerRoot) {
  writeFileSync(
    join(cwd, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
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

try {
  execFileSync("node", ["--test", "scripts/extract-quickstart-snippet.test.mjs"], {
    cwd: packageRoot,
    stdio: "inherit",
  });

  const quickstartSnippet = extractQuickstartSdkSnippet(readFileSync(quickstartPath, "utf8"));

  // Consumer smoke consumes the stamped build; it never rebuilds.
  verifyBuildStamp("sdk", repoRoot);

  const packOutput = execFileSync("node", ["scripts/pack-release.mjs", consumerRoot], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  const tarballName = packOutput.trim().split("\n").at(-1);
  if (!tarballName?.endsWith(".tgz")) {
    throw new Error(`pack-release did not report a tarball path:\n${packOutput}`);
  }
  const tarballPath = resolve(consumerRoot, tarballName);
  const installCommand = `npm install ${tarballPath}`;

  writeFileSync(
    join(consumerRoot, "package.json"),
    JSON.stringify(
      {
        name: "splitch-sdk-consumer-smoke",
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );

  run("npm", ["install", tarballPath, "typescript@6.0.3"]);

  writeFileSync(
    join(consumerRoot, "runtime.mjs"),
    `import { createSplitchClient } from "@splitch/sdk";

const client = createSplitchClient({ clientKey: "ck_smoke" });
if (typeof client.evaluate !== "function") {
  throw new Error("createSplitchClient did not return an evaluate accessor");
}
console.log("runtime import ok");
`,
  );

  writeFileSync(
    join(consumerRoot, "quickstart-snippet.ts"),
    wrapQuickstartSnippetForTypecheck(quickstartSnippet),
  );
  writeConsumerTsconfig(["quickstart-snippet.ts"]);

  run("node", ["runtime.mjs"]);
  runTypecheck();

  const staleRoot = mkdtempSync(join(tmpdir(), "splitch-sdk-consumer-stale-"));
  try {
    writeFileSync(
      join(staleRoot, "package.json"),
      JSON.stringify(
        { name: "splitch-sdk-consumer-stale", private: true, type: "module" },
        null,
        2,
      ),
    );
    run("npm", ["install", tarballPath, "typescript@6.0.3"], { cwd: staleRoot });
    writeFileSync(
      join(staleRoot, "stale-quickstart-snippet.ts"),
      wrapQuickstartSnippetForTypecheck(stripIdempotencyKeyFromSnippet(quickstartSnippet)),
    );
    writeConsumerTsconfig(["stale-quickstart-snippet.ts"], staleRoot);
    expectTypecheckFailure(staleRoot, "quickstart drift guard");
  } finally {
    rmSync(staleRoot, { recursive: true, force: true });
  }

  const packedManifest = JSON.parse(
    readFileSync(join(consumerRoot, "node_modules/@splitch/sdk/package.json"), "utf8"),
  );
  if (packedManifest.dependencies?.["@splitch/contracts"]) {
    throw new Error("packed manifest still depends on @splitch/contracts");
  }
  if (packedManifest.devDependencies?.["@splitch/contracts"]) {
    throw new Error("packed manifest still lists @splitch/contracts in devDependencies");
  }
  const declaration = readFileSync(
    join(consumerRoot, "node_modules/@splitch/sdk/dist/index.d.ts"),
    "utf8",
  );
  if (declaration.includes("@splitch/contracts")) {
    throw new Error("packed declarations still import @splitch/contracts");
  }
  if (packedManifest.devDependencies && Object.keys(packedManifest.devDependencies).length > 0) {
    throw new Error(
      `packed manifest must not ship devDependencies: ${Object.keys(packedManifest.devDependencies).join(", ")}`,
    );
  }

  const bundleJs = readFileSync(
    join(consumerRoot, "node_modules/@splitch/sdk/dist/index.js"),
    "utf8",
  );
  assertReleaseBundleJs(bundleJs);

  console.log(`dogfood install: ${installCommand}`);
  console.log("consumer smoke passed");
} finally {
  rmSync(consumerRoot, { recursive: true, force: true });
}
