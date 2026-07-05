import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const deployScript = fileURLToPath(new URL("./deploy-worker-with-sentry.mjs", import.meta.url));
const { cloudflareEnv, deployArgs } = extractCloudflareEnv(
  process.argv.slice(2).filter((arg) => arg !== "--"),
);
const commandEnv = { ...process.env };

if (cloudflareEnv) {
  commandEnv.CLOUDFLARE_ENV = cloudflareEnv;
}

run("pnpm", ["build"], { env: commandEnv });
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function fail(message) {
  console.error(`deploy-vite-worker-with-sentry: ${message}`);
  process.exit(1);
}
