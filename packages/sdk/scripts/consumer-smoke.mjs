#!/usr/bin/env node
/**
 * Consumer smoke: install the packed SDK tarball outside the monorepo workspace
 * and verify ESM runtime import plus TypeScript declaration resolution.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const consumerRoot = mkdtempSync(join(tmpdir(), "splitch-sdk-consumer-"));

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd ?? consumerRoot,
    stdio: "inherit",
    env: { ...process.env, ...options.env },
  });
}

try {
  run("npx", ["tsup", "--config", "tsup.contract-surface.config.ts"], { cwd: packageRoot });
  run("npx", ["tsup", "--config", "tsup.config.ts"], { cwd: packageRoot });

  const packOutput = execFileSync("pnpm", ["pack", "--pack-destination", consumerRoot], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  const tarballLine = packOutput
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.endsWith(".tgz"));
  if (!tarballLine) {
    throw new Error(`pack did not report a tarball path:\n${packOutput}`);
  }
  const tarballPath = resolve(consumerRoot, tarballLine);

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

  writeFileSync(
    join(consumerRoot, "types.ts"),
    `import { createSplitchClient, type ResolutionDetails, type VariantValue } from "@splitch/sdk";

export async function smoke(): Promise<VariantValue> {
  const client = createSplitchClient({ clientKey: "ck_smoke" });
  const details: ResolutionDetails = await client.evaluateDetails("flag", {
    targetingKey: "user-1",
  });
  return details.value;
}
`,
  );

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
        include: ["types.ts"],
      },
      null,
      2,
    ),
  );

  run("node", ["runtime.mjs"]);
  run("npx", ["tsc", "-p", "tsconfig.json"]);

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

  console.log("consumer smoke passed");
} finally {
  rmSync(consumerRoot, { recursive: true, force: true });
}
