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

if (isHostedWranglerEnv(cloudflareEnv) && !commandEnv.SPLITCH_DEPLOYED_COMMIT_SHA) {
  commandEnv.SPLITCH_DEPLOYED_COMMIT_SHA = commitSha();
}

validateGeneratedConfig(cloudflareEnv);
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

function commitSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const sha = result.status === 0 ? result.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    fail("hosted Vite Worker deploy requires an exact checked-out commit SHA");
  }
  return sha;
}

function validateGeneratedConfig(cloudflareEnv) {
  const configPath = join(process.cwd(), "dist/server/wrangler.json");
  if (!existsSync(configPath)) {
    fail(
      `missing prebuilt Wrangler config at ${configPath}; run this deploy through its Turborepo task`,
    );
  }

  try {
    const config = parseWranglerConfigFile(configPath);
    if (isHostedWranglerEnv(cloudflareEnv)) {
      assertGeneratedConfigTarget(config, cloudflareEnv);
      assertNoPlaceholderHostedBindings(
        config,
        `generated Wrangler config dist/server/wrangler.json for ${cloudflareEnv}`,
      );
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function assertGeneratedConfigTarget(config, cloudflareEnv) {
  const sourceConfig = parseWranglerConfigFile(join(process.cwd(), "wrangler.jsonc"));
  const expectedConfig = sourceConfig.env?.[cloudflareEnv];
  const expectedName = expectedConfig?.name ?? sourceConfig.name;
  const expectedPlatformTarget = expectedConfig?.vars?.SPLITCH_PLATFORM_TARGET;
  const actualPlatformTarget = config.vars?.SPLITCH_PLATFORM_TARGET;

  if (
    expectedPlatformTarget !== cloudflareEnv ||
    actualPlatformTarget !== expectedPlatformTarget ||
    config.name !== expectedName
  ) {
    fail(
      `prebuilt Wrangler config does not match ${cloudflareEnv}: expected name=${expectedName} SPLITCH_PLATFORM_TARGET=${expectedPlatformTarget}, received name=${config.name} SPLITCH_PLATFORM_TARGET=${actualPlatformTarget}`,
    );
  }
}

function fail(message) {
  console.error(`deploy-vite-worker-with-sentry: ${message}`);
  process.exit(1);
}
