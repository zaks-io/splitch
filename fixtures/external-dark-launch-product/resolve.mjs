#!/usr/bin/env node
/**
 * Minimal external product entrypoint for the shared-preview dark-launch dogfood gate.
 *
 * Installs only through a packed `@splitch/sdk` tarball (never the monorepo workspace) and
 * resolves a Flag via verify / evaluate exactly as another product would.
 *
 * Usage:
 *   node resolve.mjs verify  --flag <key> --targeting-key <id> [--attribute k=v]...
 *   node resolve.mjs evaluate --flag <key> --targeting-key <id> --idempotency-key <id> [--attribute k=v]...
 *
 * Env:
 *   SPLITCH_CLIENT_KEY   (required) Client Key material
 *   SPLITCH_ENDPOINT     (required) Evaluation API origin, e.g. https://edge.preview.splitch.dev
 */
import { createSplitchClient } from "@splitch/sdk";

const args = parseArgs(process.argv.slice(2));
const clientKey = requiredEnv("SPLITCH_CLIENT_KEY");
const endpoint = requiredEnv("SPLITCH_ENDPOINT");

const client = createSplitchClient({ clientKey, endpoint });
const context = {
  targetingKey: requiredFlag(args, "targeting-key"),
  idType: args["id-type"] ?? "user",
  attributes: args.attributes,
};

const action = args._[0];
if (action === "verify") {
  const details = await client.verify(requiredFlag(args, "flag"), context);
  writeJson(details);
  if (details.reason === "ERROR") process.exit(2);
  process.exit(0);
}

if (action === "evaluate") {
  const idempotencyKey = requiredFlag(args, "idempotency-key");
  const details = await client.evaluateDetails(requiredFlag(args, "flag"), {
    ...context,
    idempotencyKey,
  });
  writeJson(details);
  if (details.reason === "ERROR") process.exit(2);
  process.exit(0);
}

console.error("usage: node resolve.mjs verify|evaluate --flag <key> --targeting-key <id> ...");
process.exit(1);

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredFlag(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function parseArgs(argv) {
  const result = { _: [], attributes: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (token === "--attribute") {
      const pair = argv[index + 1];
      index += 1;
      if (!pair || !pair.includes("=")) {
        throw new Error("--attribute requires k=v");
      }
      const eq = pair.indexOf("=");
      result.attributes[pair.slice(0, eq)] = pair.slice(eq + 1);
      continue;
    }
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`--${name} requires a value`);
      }
      result[name] = value;
      continue;
    }
    result._.push(token);
  }
  return result;
}
