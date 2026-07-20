#!/usr/bin/env node
/**
 * Consumer smoke: install the packed SDK tarball outside the monorepo workspace
 * and verify ESM runtime import, TypeScript declaration resolution, and the
 * canonical consumer snippet (including required idempotencyKey) against packed
 * public declarations.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseBundleJs } from "./pack-staging.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const canonicalSnippetPath = join(packageRoot, "fixtures/canonical-consumer-snippet.ts");
const quickstartPath = join(repoRoot, "docs/spec/quickstart.md");
const consumerRoot = mkdtempSync(join(tmpdir(), "splitch-sdk-consumer-"));

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd ?? consumerRoot,
    stdio: options.stdio ?? "inherit",
    env: { ...process.env, ...options.env },
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

function writeConsumerTsconfig(include) {
  writeFileSync(
    join(consumerRoot, "tsconfig.json"),
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

function assertQuickstartRequiresIdempotencyKey() {
  const quickstart = readFileSync(quickstartPath, "utf8");
  const sectionStart = quickstart.indexOf("## 8. Wire the SDK and fire the first real Exposure");
  if (sectionStart === -1) {
    throw new Error("quickstart.md is missing section 8 SDK snippet");
  }
  const section = quickstart.slice(sectionStart, sectionStart + 2500);
  if (!section.includes("idempotencyKey")) {
    throw new Error("quickstart.md section 8 must document idempotencyKey on evaluate calls");
  }
  if (!section.includes("crypto.randomUUID()")) {
    throw new Error("quickstart.md section 8 must show a stable per-evaluation idempotency key");
  }
}

function stripIdempotencyKey(source) {
  return source
    .replace(/\n\s*const evaluationId = crypto\.randomUUID\(\);.*\n/, "\n")
    .replace(/,?\s*\n\s*idempotencyKey:\s*evaluationId/g, "");
}

try {
  run("npx", ["tsup", "--config", "tsup.contract-surface.config.ts"], { cwd: packageRoot });
  run("npx", ["tsup", "--config", "tsup.config.ts"], { cwd: packageRoot });

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

  run("npm", ["install", tarballPath, "typescript@6.0.3", "zod@4.4.3"]);

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

  copyFileSync(canonicalSnippetPath, join(consumerRoot, "canonical-consumer-snippet.ts"));
  writeConsumerTsconfig(["canonical-consumer-snippet.ts"]);
  assertQuickstartRequiresIdempotencyKey();

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
    run("npm", ["install", tarballPath, "typescript@6.0.3", "zod@4.4.3"], { cwd: staleRoot });
    const canonicalSource = readFileSync(canonicalSnippetPath, "utf8");
    writeFileSync(
      join(staleRoot, "stale-consumer-snippet.ts"),
      stripIdempotencyKey(canonicalSource),
    );
    writeFileSync(
      join(staleRoot, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
          },
          include: ["stale-consumer-snippet.ts"],
        },
        null,
        2,
      ),
    );
    expectTypecheckFailure(staleRoot, "drift guard");
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
