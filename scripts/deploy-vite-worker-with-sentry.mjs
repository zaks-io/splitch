import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

  assertGeneratedHostedConfigRedirect(configPath);
}

// @cloudflare/vite-plugin's build writes .wrangler/deploy/config.json to redirect
// `wrangler deploy` at the generated dist/server/wrangler.json instead of the
// source wrangler.jsonc (whose `main` is a virtual module esbuild cannot
// resolve). If that redirect is missing, malformed, or stale, wrangler silently
// falls back to the source config and the failure only surfaces much later,
// deep inside esbuild. Turborepo's build cache can restore dist/ without
// restoring .wrangler/deploy/ if the redirect isn't a declared build output, so
// this must be re-checked on every deploy, not assumed from the build having run.
function assertGeneratedHostedConfigRedirect(generatedConfigPath) {
  const redirectPath = join(process.cwd(), ".wrangler/deploy/config.json");

  if (!existsSync(redirectPath)) {
    fail(
      `missing Wrangler deploy redirect at ${redirectPath}; without it, wrangler deploy falls back to the source wrangler.jsonc and fails inside esbuild. Rebuild this package through its Turborepo build task (Turborepo must cache .wrangler/deploy/** alongside dist/**; a stale cache is a bug in turbo.json) before deploying again`,
    );
  }

  let redirect;
  try {
    redirect = JSON.parse(readFileSync(redirectPath, "utf8"));
  } catch (error) {
    fail(
      `unparseable Wrangler deploy redirect at ${redirectPath}: ${error instanceof Error ? error.message : String(error)}; delete .wrangler/deploy and rebuild this package through its Turborepo build task`,
    );
    return;
  }

  if (typeof redirect.configPath !== "string" || redirect.configPath.length === 0) {
    fail(
      `Wrangler deploy redirect at ${redirectPath} has no configPath; delete .wrangler/deploy and rebuild this package through its Turborepo build task`,
    );
    return;
  }

  const resolvedRedirectTarget = resolve(dirname(redirectPath), redirect.configPath);
  const resolvedGeneratedConfigPath = resolve(generatedConfigPath);
  if (resolvedRedirectTarget !== resolvedGeneratedConfigPath) {
    fail(
      `Wrangler deploy redirect at ${redirectPath} points at ${resolvedRedirectTarget}, not the validated generated config ${resolvedGeneratedConfigPath}; delete .wrangler/deploy and rebuild this package through its Turborepo build task so the redirect matches the config that was just checked`,
    );
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
