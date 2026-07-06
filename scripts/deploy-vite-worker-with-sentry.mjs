import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoPlaceholderHostedBindings, isHostedWranglerEnv } from "./lib/hosted-bindings.mjs";
import { parseWranglerConfigFile } from "./lib/wrangler-config.mjs";

const deployScript = fileURLToPath(new URL("./deploy-worker-with-sentry.mjs", import.meta.url));
const { cloudflareEnv: cliCloudflareEnv, deployArgs } = extractCloudflareEnv(
  process.argv.slice(2).filter((arg) => arg !== "--"),
);
const cloudflareEnv = cliCloudflareEnv ?? readHostedEnvFromProcessEnv(process.env);
const commandEnv = { ...process.env };

if (cloudflareEnv) {
  commandEnv.CLOUDFLARE_ENV = cloudflareEnv;
  commandEnv.SPLITCH_GENERATED_WRANGLER_ENV = cloudflareEnv;
}

run("pnpm", ["build"], { env: commandEnv });
validateGeneratedHostedConfig(cloudflareEnv);
run("node", [deployScript, ...deployArgs], { env: commandEnv });

function extractCloudflareEnv(args) {
  const deployArgs = [];
  let cloudflareEnv;

  for (let index = 0; index < args.length; index += 1) {
    const envArg = readCloudflareEnvArg(args, index);
    if (envArg) {
      cloudflareEnv = envArg.value;
      index += envArg.consumedArgs;
      continue;
    }

    deployArgs.push(args[index]);
  }

  return { cloudflareEnv, deployArgs };
}

function readCloudflareEnvArg(args, index) {
  const arg = args[index];

  if (arg === "--env" || arg === "-e") {
    return requiredCloudflareEnv(arg, args[index + 1], 1);
  }

  if (arg.startsWith("--env=")) {
    return requiredCloudflareEnv("--env", arg.slice("--env=".length), 0);
  }

  return undefined;
}

function requiredCloudflareEnv(flag, value, consumedArgs) {
  if (!value || value.startsWith("-")) {
    fail(`${flag} requires an environment name`);
  }

  return { value, consumedArgs };
}

function readHostedEnvFromProcessEnv(env) {
  for (const name of ["CLOUDFLARE_ENV", "SPLITCH_PLATFORM_TARGET"]) {
    const value = env[name];
    if (isHostedWranglerEnv(value)) {
      return value;
    }
  }
  return undefined;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function validateGeneratedHostedConfig(cloudflareEnv) {
  if (!isHostedWranglerEnv(cloudflareEnv)) {
    return;
  }

  const configPath = join(process.cwd(), "dist/server/wrangler.json");
  if (!existsSync(configPath)) {
    fail(`missing generated Wrangler config at ${configPath} for ${cloudflareEnv}`);
  }

  try {
    const config = parseWranglerConfigFile(configPath);
    assertNoPlaceholderHostedBindings(
      config,
      `generated Wrangler config dist/server/wrangler.json for ${cloudflareEnv}`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function fail(message) {
  console.error(`deploy-vite-worker-with-sentry: ${message}`);
  process.exit(1);
}
