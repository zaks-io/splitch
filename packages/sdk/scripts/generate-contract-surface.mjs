#!/usr/bin/env node
/**
 * Sole writer of `scripts/generated/contract-surface-members.ts`.
 *
 * The SDK ships a zod-free copy of the data-plane contract surface (SPL-325).
 * Its enum members and response key lists are a mechanical projection of the
 * `@splitch/contracts` Zod schemas, so they are derived here instead of being
 * retyped by hand: the retyped copy drifted the moment contracts gained an
 * error code, and that took main red.
 *
 * Zod runs at build time only. This script reads schema members and writes
 * plain TypeScript literals; nothing it emits carries a zod import, so the
 * published bundle stays dependency-free. Docblocks anywhere in this
 * surface can land verbatim in the published `dist/index.d.ts`, so comments in
 * the surface must stay consumer-facing: no script paths, release-pack rules,
 * or contracts-package plumbing. The complete forbidden marker list is
 * maintained in `scripts/pack-staging.mjs`.
 *
 * What is NOT generated: the object shapes in `contract-surface-types.ts` and
 * the JSON type nodes in `contract-surface-descriptors.ts`. Emitting TypeScript
 * declarations from Zod would be a second code generator with its own drift
 * surface, so those stay hand-written. They cannot drift silently:
 * `src/contract-surface-assignability.ts` asserts bidirectional type equality
 * against the contracts inference and fails `pnpm typecheck`, and
 * `contract-surface-structural.test.ts` compares the descriptors against
 * `z.toJSONSchema()` of the same contracts schemas. Runtime refinements are not
 * represented by either, so `contract-surface-proto-safe.test.ts` walks the live
 * contracts schema graph and checks guarded response paths behaviorally.
 *
 * Contracts is reached by relative path rather than by a manifest dependency.
 * `packages/sdk/package.json` must keep zero dependencies AND zero
 * devDependencies -- `scripts/pack-staging.mjs` fails the release pack on
 * either. The build-graph edge lives in `turbo.json`, which lists
 * `packages/contracts/src/**` in the SDK's build/typecheck/test inputs.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEsbuild } from "./size-check.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractsSrc = resolve(packageRoot, "../contracts/src");
const outputPath = join(packageRoot, "scripts/generated/contract-surface-members.ts");

/**
 * Bundled with `resolveDir` pointing at the contracts sources so both the
 * relative leaf imports and contracts' own `zod` resolve the way they do for
 * contracts itself.
 */
const CONTRACTS_PROBE = `
export { errorCodes } from "./error-code";
export { resolutionReasons } from "./leaves/resolution-reason";
export {
  EvaluateAllEntrySchema,
  EvaluateAllReasonSchema,
  EvaluateAllResponseSchema,
} from "./leaves/evaluate-all-wire";
export {
  DataPlaneEvaluateResponseSchema,
  PeekEvaluateResponseSchema,
} from "./leaves/data-plane-evaluate-wire";
export { ResolutionDetailsSchema } from "./leaves/resolution-details";
export { z } from "zod";
`;

async function loadContracts() {
  const esbuild = await loadEsbuild();
  const bundled = await esbuild.build({
    stdin: {
      contents: CONTRACTS_PROBE,
      resolveDir: contractsSrc,
      loader: "ts",
      sourcefile: "contract-surface-probe.ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    write: false,
  });
  const staging = mkdtempSync(join(tmpdir(), "splitch-contract-surface-"));
  try {
    const modulePath = join(staging, "contracts.mjs");
    writeFileSync(modulePath, bundled.outputFiles[0].text);
    return await import(pathToFileURL(modulePath).href);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function jsonSchema(z, schema, name) {
  const json = z.toJSONSchema(schema);
  if (json.type !== "object") {
    throw new Error(`${name}: expected an object schema, got ${String(json.type)}`);
  }
  return json;
}

function requiredKeys(z, schema, name) {
  const required = jsonSchema(z, schema, name).required;
  if (!Array.isArray(required) || required.length === 0) {
    throw new Error(`${name}: expected at least one required key`);
  }
  return required;
}

function propertyKeys(z, schema, name) {
  const properties = jsonSchema(z, schema, name).properties;
  if (!properties || Object.keys(properties).length === 0) {
    throw new Error(`${name}: expected at least one property`);
  }
  return Object.keys(properties);
}

function enumMembers(schema, name) {
  const options = schema.options;
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error(`${name}: expected a non-empty enum`);
  }
  return options;
}

function literalArray(name, values) {
  const members = values.map((value) => `  ${JSON.stringify(value)},`).join("\n");
  return `export const ${name} = [\n${members}\n] as const;`;
}

function unionAlias(typeName, constName) {
  return `export type ${typeName} = (typeof ${constName})[number];`;
}

const HEADER = `/** Generated file; do not edit. */`;

function render(contracts) {
  const { z } = contracts;
  const blocks = [
    literalArray("errorCodes", contracts.errorCodes),
    unionAlias("ErrorCode", "errorCodes"),
    literalArray("resolutionReasons", contracts.resolutionReasons),
    unionAlias("ResolutionReason", "resolutionReasons"),
    literalArray(
      "evaluateAllReasons",
      enumMembers(contracts.EvaluateAllReasonSchema, "EvaluateAllReasonSchema"),
    ),
    unionAlias("EvaluateAllReason", "evaluateAllReasons"),
    literalArray(
      "dataPlaneEvaluateRequiredKeys",
      requiredKeys(z, contracts.DataPlaneEvaluateResponseSchema, "DataPlaneEvaluateResponseSchema"),
    ),
    literalArray(
      "peekEvaluateRequiredKeys",
      requiredKeys(z, contracts.PeekEvaluateResponseSchema, "PeekEvaluateResponseSchema"),
    ),
    literalArray(
      "resolutionDetailsPropertyKeys",
      propertyKeys(z, contracts.ResolutionDetailsSchema, "ResolutionDetailsSchema"),
    ),
    literalArray(
      "resolutionDetailsRequiredKeys",
      requiredKeys(z, contracts.ResolutionDetailsSchema, "ResolutionDetailsSchema"),
    ),
    literalArray(
      "evaluateAllEntryRequiredKeys",
      requiredKeys(z, contracts.EvaluateAllEntrySchema, "EvaluateAllEntrySchema"),
    ),
    literalArray(
      "evaluateAllResponseRequiredKeys",
      requiredKeys(z, contracts.EvaluateAllResponseSchema, "EvaluateAllResponseSchema"),
    ),
  ];
  return `${HEADER}\n${blocks.join("\n\n")}\n`;
}

const contracts = await loadContracts();
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, render(contracts));
console.log(`generate: wrote ${outputPath}`);
