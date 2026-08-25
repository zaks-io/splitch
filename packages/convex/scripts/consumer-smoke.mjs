#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBuildStamp } from "../../../scripts/release/build-stamp.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const consumer = mkdtempSync(join(tmpdir(), "splitch-convex-consumer-"));
try {
  verifyBuildStamp("convex", repoRoot);
  const output = execFileSync("node", ["scripts/pack-release.mjs", consumer], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  const name = output.trim().split("\n").at(-1);
  if (!name?.endsWith(".tgz")) throw new Error(`pack-release did not report a tarball:\n${output}`);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "convex-consumer", private: true, type: "module" }),
  );
  execFileSync(
    "npm",
    [
      "install",
      join(consumer, name),
      "convex@1.45.0",
      "react@19.2.8",
      "react-dom@19.2.8",
      "@types/react@19.2.17",
      "typescript@6.0.3",
    ],
    {
      cwd: consumer,
      stdio: "inherit",
      env: { ...process.env, npm_config_cache: join(consumer, ".npm-cache") },
    },
  );
  writeFileSync(
    join(consumer, "index.ts"),
    `import { Splitch } from "@splitch/convex";
import type { ComponentApi } from "@splitch/convex/_generated/component";
import splitch from "@splitch/convex/convex.config.js";
import { createSplitchReact } from "@splitch/convex/react";
import {
  type DataModelFromSchemaDefinition,
  defineApp,
  defineSchema,
  defineTable,
  type GenericActionCtx,
  type GenericMutationCtx,
  type GenericQueryCtx,
  makeFunctionReference,
} from "convex/server";
import { v } from "convex/values";

const app = defineApp({ env: { SPLITCH_API_KEY: v.string() } });
app.use(splitch, { httpPrefix: "/integrations/splitch/", env: { SPLITCH_API_KEY: app.env.SPLITCH_API_KEY } });
declare const component: ComponentApi;
const flags = new Splitch(component);
const schema = defineSchema({ checks: defineTable({ value: v.boolean() }) });
type DataModel = DataModelFromSchemaDefinition<typeof schema>;
declare const actionCtx: GenericActionCtx<DataModel>;
declare const mutationCtx: GenericMutationCtx<DataModel>;
declare const queryCtx: GenericQueryCtx<DataModel>;
void flags.install(actionCtx);
void flags.peekVariant(queryCtx, "flag", { targetingKey: "entity" }, false);
void flags.evaluate(mutationCtx, "flag", { targetingKey: "entity", idempotencyKey: "once" }, false);
const reactQuery = makeFunctionReference<"query", { flagKey: string; defaultValue: boolean }, Awaited<ReturnType<typeof flags.peekDetails>>>("flags:resolve");
const { useFlag, useFlagDetails } = createSplitchReact(reactQuery);
void useFlag;
void useFlagDetails;
export default app;
`,
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
      },
      include: ["index.ts"],
    }),
  );
  execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: consumer, stdio: "inherit" });
  execFileSync(
    "node",
    ["--input-type=module", "--eval", 'import "@splitch/convex/convex.config.js"'],
    {
      cwd: consumer,
      stdio: "inherit",
    },
  );
  console.log("@splitch/convex clean consumer smoke passed");
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
