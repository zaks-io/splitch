import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SplitchCliError } from "./errors.js";

interface SplitchConfig {
  readonly version: 1;
  readonly app?: string;
  readonly environment?: string;
}

type ContextSource = "flag" | "env" | "config";

export interface ResolvedContext {
  readonly appId?: string;
  readonly environmentId?: string;
  readonly appSource?: ContextSource;
  readonly environmentSource?: ContextSource;
  readonly configPath?: string;
}

export interface ContextFlags {
  readonly app?: string;
  readonly env?: string;
}

export const SCOPE_REMEDY =
  "Set scope with `splitch use --app <app_id|slug> [--env <environment_id|slug>]` or pass `--app` / `--env`.";

export async function resolveContext(options: {
  readonly flags: ContextFlags;
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
}): Promise<ResolvedContext> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const fromFlags = resolveFlagAndEnv(options.flags, env);
  const discovered = await discoverConfig(cwd);
  return mergeResolvedContext(fromFlags, discovered);
}

export function requireAppScope(
  context: ResolvedContext,
  needsApp: boolean,
): { ok: true; appId: string } | { ok: false; message: string } {
  if (!needsApp) {
    return { ok: true, appId: context.appId ?? "" };
  }
  if (!context.appId) {
    return {
      ok: false,
      message: `App scope is unresolved. ${SCOPE_REMEDY}`,
    };
  }
  return { ok: true, appId: context.appId };
}

export function requireEnvironmentScope(
  context: ResolvedContext,
  needsEnvironment: boolean,
): { ok: true; environmentId: string } | { ok: false; message: string } {
  if (!needsEnvironment) {
    return { ok: true, environmentId: context.environmentId ?? "" };
  }
  if (!context.environmentId) {
    return {
      ok: false,
      message: `Environment scope is unresolved. ${SCOPE_REMEDY}`,
    };
  }
  return { ok: true, environmentId: context.environmentId };
}

export async function writeNearestConfig(
  cwd: string,
  update: { app?: string; environment?: string | null },
): Promise<string> {
  // Update the config the read path (discoverConfig) would resolve, walking
  // ancestors so `splitch use` in a subdirectory edits the project config
  // instead of shadowing it with a partial cwd-local file that silently drops
  // the inherited App scope. Fall back to cwd only when none exists.
  // `environment: null` explicitly clears the stored value (an App switch
  // invalidates the old App's Environment); undefined leaves it unchanged.
  const discovered = await discoverConfig(cwd);
  const path = discovered?.path ?? join(cwd, ".splitch", "config.json");
  const existing: SplitchConfig = discovered?.config ?? { version: 1 };
  const next: SplitchConfig = {
    version: 1,
    app: update.app ?? existing.app,
    environment:
      update.environment === null ? undefined : (update.environment ?? existing.environment),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  return path;
}

function resolveFlagAndEnv(
  flags: ContextFlags,
  env: Record<string, string | undefined>,
): Pick<ResolvedContext, "appId" | "environmentId" | "appSource" | "environmentSource"> {
  return {
    appId: flags.app ?? env.SPLITCH_APP,
    appSource: flags.app ? "flag" : env.SPLITCH_APP ? "env" : undefined,
    environmentId: flags.env ?? env.SPLITCH_ENV,
    environmentSource: flags.env ? "flag" : env.SPLITCH_ENV ? "env" : undefined,
  };
}

function mergeResolvedContext(
  current: Pick<ResolvedContext, "appId" | "environmentId" | "appSource" | "environmentSource">,
  discovered: { path: string; config: SplitchConfig } | null,
): ResolvedContext {
  if (!discovered) {
    return current;
  }
  return {
    appId: current.appId ?? discovered.config.app,
    environmentId: current.environmentId ?? discovered.config.environment,
    appSource: current.appSource ?? (discovered.config.app ? "config" : undefined),
    environmentSource:
      current.environmentSource ?? (discovered.config.environment ? "config" : undefined),
    configPath: discovered.path,
  };
}

async function discoverConfig(
  cwd: string,
): Promise<{ path: string; config: SplitchConfig } | null> {
  let current = resolve(cwd);
  const root = resolve("/");
  while (true) {
    const candidate = join(current, ".splitch", "config.json");
    const config = await readConfig(candidate);
    if (config) {
      return { path: candidate, config };
    }
    if (current === root) {
      break;
    }
    current = dirname(current);
  }
  const homeConfig = join(homedir(), ".splitch", "config.json");
  const home = await readConfig(homeConfig);
  return home ? { path: homeConfig, config: home } : null;
}

async function readConfig(path: string): Promise<SplitchConfig | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as SplitchConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new SplitchCliError({
      code: "CLI_CONFIG_READ_FAILED",
      causeSummary: error instanceof Error ? error.message : String(error),
      remediation: "Fix or remove the unreadable .splitch/config.json file and retry the command",
      originalError: error,
    });
  }
}
