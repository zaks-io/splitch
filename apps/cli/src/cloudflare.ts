import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CloudflareInstallationStatusSchema,
  ErrorResponseSchema,
} from "@splitch/sdk/control-plane";
import {
  assertRecordedBindingPath,
  assertServiceBindingAvailable,
  assertServiceBindingsRemovable,
  installServiceBinding,
  recordedWranglerEnvironment,
  removeServiceBinding,
  SERVICE_BINDING,
  serviceBindingPath,
} from "./cloudflare-binding.js";
import { cloudflareUsage as usage } from "./cloudflare-error.js";
import {
  assertCloudflarePackage,
  boundIntegrationConfigs,
  assertGeneratedTargetsAvailable,
  assertStateEnvironment,
  assertStateProject,
  type CloudflareState,
  ensureCloudflareStateIgnored,
  findApplicationConfig,
  generatedPaths,
  readState,
  requireState,
  workerName,
  writeIntegrationFiles,
  writeState,
} from "./cloudflare-files.js";
import {
  requireWrangler4,
  systemCommandRunner,
  wrangler,
  wranglerSecret,
  wranglerTypes,
} from "./cloudflare-wrangler.js";
import type { CliCommandDefinition } from "./command-registry.js";
import type { ResolvedContext } from "./context.js";
import { emit } from "./execute-io.js";
import type { CliCommandRunner, CliDeps, CliIo, CliResult } from "./execute-types.js";
import { EXIT_OK } from "./exit-codes.js";
import type { ParsedInvocation } from "./parse-args.js";
import { resolveDataPlaneBaseUrl } from "./sdks.js";

type CloudflareCommandKind = Extract<
  CliCommandDefinition["kind"],
  "cloudflare_setup" | "cloudflare_status" | "cloudflare_remove"
>;

const CONFIGURATION_PATH = "/integrations/splitch/configuration";
const POLL_ATTEMPTS = 60;

export async function executeCloudflareCommand(
  kind: CloudflareCommandKind,
  invocation: ParsedInvocation,
  deps: CliDeps,
  io: CliIo,
  context: ResolvedContext,
): Promise<CliResult> {
  const environment = context.environmentId;
  if (!environment) throw usage("Cloudflare commands require a selected Environment");
  if (invocation.positionals.length > 0)
    throw usage(`Unexpected argument ${JSON.stringify(invocation.positionals[0])}`);
  if (kind === "cloudflare_setup") return setup(environment, invocation, deps, io);
  if (kind === "cloudflare_status") return status(environment, invocation, deps, io);
  return remove(environment, invocation, deps, io);
}

async function setup(
  environment: string,
  invocation: ParsedInvocation,
  deps: CliDeps,
  io: CliIo,
): Promise<CliResult> {
  const cwd = resolve(deps.cwd ?? process.cwd());
  const apiKey = requireApiKey(deps);
  const runner = deps.commandRunner ?? systemCommandRunner;
  const generated = generatedPaths(cwd, environment);
  const stored = await readState(generated.statePath);
  const existing = stored ? await assertStateProject(cwd, environment, stored) : null;
  const requestedWranglerEnvironment = invocation.flags.wranglerEnv;
  // A removed installation no longer owns a binding, and setup derives a fresh path for it.
  if (existing && !existing.removedAt) {
    await assertRecordedBindingPath(existing);
    assertRecordedWranglerEnvironment(existing, requestedWranglerEnvironment);
  }
  if (!existing) await assertGeneratedTargetsAvailable(generated);
  await assertCloudflarePackage(cwd);
  const appConfigPath = existing?.appConfigPath ?? (await findApplicationConfig(cwd));
  await requireWrangler4(runner, cwd);
  const state: CloudflareState =
    existing && !existing.removedAt
      ? existing
      : {
          version: 1,
          environment,
          workerName: workerName(environment),
          installationId: randomUUID(),
          pushSecret: Buffer.from(randomBytes(32)).toString("base64url"),
          endpoint: "",
          appConfigPath,
          appBindingPath: await serviceBindingPath(
            appConfigPath,
            environment,
            requestedWranglerEnvironment,
          ),
        };
  assertStateEnvironment(state, environment);
  await assertServiceBindingAvailable(state);
  // The types run comes last, so its inputs are checked before anything is deployed.
  await boundIntegrationConfigs(cwd, appConfigPath, environment);
  await validateApiKey(apiKey, deps);
  await ensureCloudflareStateIgnored(cwd);
  await writeIntegrationFiles(generated, state, deps);

  const deploy = await wrangler(runner, cwd, ["deploy", "--config", generated.configPath]);
  const installed = {
    ...state,
    endpoint: `${workersDevOrigin(deploy.stdout, deploy.stderr)}${CONFIGURATION_PATH}`,
    removedAt: undefined,
  };
  await wranglerSecret(runner, cwd, generated.configPath, "SPLITCH_API_KEY", apiKey);
  await wranglerSecret(
    runner,
    cwd,
    generated.configPath,
    "SPLITCH_PUSH_SECRET",
    installed.pushSecret,
  );
  await registerInstallation(installed, apiKey, deps);
  const delivery = await waitForApplied(installed, apiKey, deps);
  await installServiceBinding(installed);
  const typesCommand = await wranglerTypes(runner, cwd, installed.appConfigPath);
  await writeState(generated.statePath, installed);

  const payload = {
    workerName: installed.workerName,
    endpoint: installed.endpoint,
    installationId: installed.installationId,
    environmentVersion: delivery.environmentVersion,
    appliedEnvironmentVersion: delivery.lastAppliedVersion,
    status: delivery.status,
    serviceBinding: SERVICE_BINDING,
    typesCommand,
  };
  emit(io, invocation.flags.json, payload);
  return { exitCode: EXIT_OK, payload };
}

async function status(
  environment: string,
  invocation: ParsedInvocation,
  deps: CliDeps,
  io: CliIo,
): Promise<CliResult> {
  const state = await requireState(resolve(deps.cwd ?? process.cwd()), environment);
  await assertRecordedBindingPath(state);
  const delivery = await installationStatus(state, requireApiKey(deps), deps);
  const payload = { workerName: state.workerName, ...delivery };
  emit(io, invocation.flags.json, payload);
  return { exitCode: EXIT_OK, payload };
}

async function remove(
  environment: string,
  invocation: ParsedInvocation,
  deps: CliDeps,
  io: CliIo,
): Promise<CliResult> {
  const cwd = resolve(deps.cwd ?? process.cwd());
  const state = await requireState(cwd, environment);
  await assertServiceBindingsRemovable(state);
  // Checked before the DELETE, so a missing generated config cannot strand remove halfway.
  await boundIntegrationConfigs(cwd, state.appConfigPath);
  await integrationRequest(state, requireApiKey(deps), deps, { method: "DELETE" });
  const runner = deps.commandRunner ?? systemCommandRunner;
  // Without a removed binding nothing in the application config changed, so its types stay.
  const replaced = await removeServiceBinding(state);
  if (replaced !== null) await typesOrRestore(runner, cwd, state.appConfigPath, replaced);
  await wrangler(runner, cwd, [
    "delete",
    "--config",
    generatedPaths(cwd, environment).configPath,
    "--name",
    state.workerName,
  ]);
  await writeState(generatedPaths(cwd, environment).statePath, {
    ...state,
    removedAt: new Date().toISOString(),
  });
  const payload = {
    workerName: state.workerName,
    installationId: state.installationId,
    removed: true,
  };
  emit(io, invocation.flags.json, payload);
  return { exitCode: EXIT_OK, payload };
}

// Types follow the edit before the Worker delete, and a failed types run puts the binding back, so
// every rerun that removes the binding also regenerates the types.
async function typesOrRestore(
  runner: CliCommandRunner,
  cwd: string,
  appConfigPath: string,
  replaced: string,
): Promise<void> {
  try {
    await wranglerTypes(runner, cwd, appConfigPath);
  } catch (error) {
    await writeFile(appConfigPath, replaced);
    throw error;
  }
}

async function registerInstallation(
  state: CloudflareState,
  apiKey: string,
  deps: CliDeps,
): Promise<void> {
  await integrationRequest(state, apiKey, deps, {
    method: "POST",
    body: JSON.stringify({
      installationId: state.installationId,
      endpoint: state.endpoint,
      pushSecret: state.pushSecret,
    }),
  });
}

async function installationStatus(state: CloudflareState, apiKey: string, deps: CliDeps) {
  const response = await integrationRequest(state, apiKey, deps, { method: "GET" });
  return CloudflareInstallationStatusSchema.parse(await response.json());
}

async function waitForApplied(state: CloudflareState, apiKey: string, deps: CliDeps) {
  const sleep =
    deps.sleep ?? ((milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds)));
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const current = await installationStatus(state, apiKey, deps);
    if (current.lastAppliedVersion === current.environmentVersion) return current;
    if (current.terminalCount > 0)
      throw usage("Cloudflare configuration delivery entered a terminal state");
    await sleep(1_000);
  }
  throw usage("Cloudflare Worker did not apply the current Environment version within 60 seconds");
}

async function integrationRequest(
  state: Pick<CloudflareState, "installationId">,
  apiKey: string,
  deps: CliDeps,
  init: RequestInit,
): Promise<Response> {
  const baseUrl = resolveDataPlaneBaseUrl(deps).replace(/\/$/, "");
  const suffix = init.method === "POST" ? "" : `/${state.installationId}`;
  const response = await (deps.fetch ?? fetch)(
    `${baseUrl}/api/integrations/cloudflare/installations${suffix}`,
    {
      ...init,
      redirect: "error",
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    },
  );
  if (!response.ok) throw usage(`Cloudflare integration API returned HTTP ${response.status}`);
  return response;
}

async function validateApiKey(apiKey: string, deps: CliDeps): Promise<void> {
  const baseUrl = resolveDataPlaneBaseUrl(deps).replace(/\/$/, "");
  const response = await (deps.fetch ?? fetch)(
    `${baseUrl}/api/integrations/cloudflare/installations/${randomUUID()}`,
    {
      method: "GET",
      redirect: "error",
      headers: { authorization: `Bearer ${apiKey}` },
    },
  );
  if (response.status !== 404)
    throw usage(`Cloudflare integration API returned HTTP ${response.status}`);
  const error = ErrorResponseSchema.safeParse(await response.json().catch(() => null));
  if (!error.success || error.data.code !== "CLOUDFLARE_INSTALLATION_NOT_FOUND")
    throw usage("Cloudflare integration API did not return the expected authenticated contract");
}

// Moving the binding would orphan the one already in the application config,
// so a different target requires an explicit remove first.
function assertRecordedWranglerEnvironment(state: CloudflareState, requested?: string): void {
  if (requested === undefined || requested === recordedWranglerEnvironment(state)) return;
  throw usage(
    `The ${state.environment} integration binds ${SERVICE_BINDING} at ${state.appBindingPath.join(".")}, not Wrangler Environment ${JSON.stringify(requested)}; rerun without --wrangler-env, or run splitch cloudflare remove first`,
  );
}

function workersDevOrigin(...outputs: string[]): string {
  const match = outputs.join("\n").match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  if (!match) throw usage("Wrangler deploy did not report a workers.dev URL");
  return match[0].replace(/\/$/, "");
}

function requireApiKey(deps: CliDeps): string {
  const apiKey = (deps.env ?? process.env).SPLITCH_API_KEY;
  if (!apiKey)
    throw usage("SPLITCH_API_KEY is required and must be bound to one App and Environment");
  return apiKey;
}
