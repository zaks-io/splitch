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
 *   node resolve.mjs track --event <name> --targeting-key <id> --event-id <id> [--field k=v]...
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
const action = args._[0];
if (action === "track") {
  const result = await client.track(requiredFlag(args, "event"), {
    targetingKey: requiredFlag(args, "targeting-key"),
    idType: args["id-type"] ?? "user",
    eventId: requiredFlag(args, "event-id"),
    fields: args.fields,
    dimensions: {},
  });
  await writeJson(result);
} else {
  const context = {
    targetingKey: requiredFlag(args, "targeting-key"),
    idType: args["id-type"] ?? "user",
    attributes: args.attributes,
  };

  if (action === "verify") {
    const details = await client.verify(requiredFlag(args, "flag"), context);
    await writeJson(details);
    if (details.reason === "ERROR") process.exitCode = 2;
  } else if (action === "evaluate") {
    const idempotencyKey = requiredFlag(args, "idempotency-key");
    const details = await client.evaluateDetails(requiredFlag(args, "flag"), {
      ...context,
      idempotencyKey,
    });
    await writeJson(details);
    if (details.reason === "ERROR") process.exitCode = 2;
  } else {
    console.error("usage: node resolve.mjs verify|evaluate|track --targeting-key <id> ...");
    process.exitCode = 1;
  }
}

function writeJson(value) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
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
  const result = { _: [], attributes: {}, fields: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (token === "--attribute" || token === "--field") {
      index += 1;
      addPair(result, token, argv[index]);
      continue;
    }
    if (token.startsWith("--")) {
      index += 1;
      addNamed(result, token.slice(2), argv[index]);
      continue;
    }
    result._.push(token);
  }
  return result;
}

function addPair(result, token, pair) {
  if (!pair?.includes("=")) throw new Error(`${token} requires k=v`);
  const eq = pair.indexOf("=");
  const target = token === "--attribute" ? result.attributes : result.fields;
  const value = pair.slice(eq + 1);
  target[pair.slice(0, eq)] = token === "--field" ? parseScalar(value) : value;
}

function addNamed(result, name, value) {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  result[name] = value;
}

function parseScalar(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && Number.isFinite(Number(value))) return Number(value);
  return value;
}
