import { existsSync, readFileSync, statSync } from "node:fs";
import { appendFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { CliErrorDetail } from "./errors.js";
import { SplitchCliError } from "./errors.js";
import type { ParsedGlobalFlags } from "./parse-args.js";

export const DEFAULT_PERSONAL_ACCESS_TOKEN_ENV_VAR = "SPLITCH_MCP_TOKEN";
const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Where and how `tokens create|rotate` writes the once-only secret. The secret
 * is NEVER printed, so an agent can create and rotate tokens without reading
 * one: it lands in a 0600 file (raw, or as a `NAME=value` env line that can be
 * appended to an existing env file), and stdout carries metadata only.
 */
export interface PersonalAccessTokenSecretTarget {
  readonly path: string;
  readonly format: "env" | "raw";
  readonly envVar: string;
  readonly append: boolean;
  readonly force: boolean;
}

export function personalAccessTokenSecretTarget(
  flags: ParsedGlobalFlags,
): PersonalAccessTokenSecretTarget | CliErrorDetail {
  if (!flags.outputFile) {
    return usage(
      "--output-file is required: the token secret is written to a file and never printed",
      "Pass --output-file <path>, e.g. --output-file ~/.config/splitch/mcp.env --append",
    );
  }
  const format = flags.secretFormat ?? "env";
  if (format !== "env" && format !== "raw") {
    return usage(`--secret-format ${format} is not env or raw`, "Pass --secret-format env or raw");
  }
  if (format === "raw" && (flags.append || flags.envVar)) {
    return usage(
      "--append and --env-var need --secret-format env",
      "Drop --secret-format raw, or drop --append and --env-var",
    );
  }
  const envVar = flags.envVar ?? DEFAULT_PERSONAL_ACCESS_TOKEN_ENV_VAR;
  if (!ENV_VAR_PATTERN.test(envVar)) {
    return usage(`--env-var ${envVar} is not a valid variable name`, "Use letters, digits, and _");
  }
  const target = {
    path: resolve(flags.outputFile),
    format,
    envVar,
    append: flags.append,
    force: flags.force,
  } as const;
  return targetPathError(flags.outputFile, target) ?? target;
}

/** Refuse, BEFORE any secret is minted, every target the write would refuse. */
function targetPathError(
  raw: string,
  target: PersonalAccessTokenSecretTarget,
): CliErrorDetail | null {
  if (raw === "-" || /^\/(dev|proc)\//.test(target.path)) {
    return usage(
      `--output-file ${raw} would expose the secret on a terminal or stream`,
      "Pass a regular file path",
    );
  }
  if (!existsSync(target.path)) return null;
  if (!statSync(target.path).isFile()) {
    return usage(`--output-file ${target.path} is not a regular file`, "Pass a regular file path");
  }
  return target.append ? appendTargetError(target) : overwriteTargetError(target);
}

function overwriteTargetError(target: PersonalAccessTokenSecretTarget): CliErrorDetail | null {
  if (target.force) return null;
  return usage(
    `--output-file ${target.path} already exists`,
    "Pass --append to add the token to it, --force to overwrite it, or a new path",
  );
}

function appendTargetError(target: PersonalAccessTokenSecretTarget): CliErrorDetail | null {
  const mode = statSync(target.path).mode;
  if ((mode & 0o077) !== 0) {
    return usage(
      `--output-file ${target.path} is readable by other users (mode ${(mode & 0o777).toString(8)})`,
      `Restrict it first: chmod 600 ${target.path}`,
    );
  }
  if (!target.force && definesVariable(readFileSync(target.path, "utf8"), target.envVar)) {
    return usage(
      `${target.path} already defines ${target.envVar}`,
      "Pass --force to replace that line, or --env-var to write a different variable",
    );
  }
  return null;
}

/**
 * Write the secret and return the payload with the secret removed. On a write
 * failure the token is unusable (nobody holds its secret), so `onWriteFailure`
 * revokes it before the error is raised.
 */
export async function writePersonalAccessTokenSecret(
  data: unknown,
  target: PersonalAccessTokenSecretTarget,
  onWriteFailure: (tokenId: string) => Promise<boolean>,
): Promise<Record<string, unknown>> {
  const payload = data as { token?: { id?: unknown }; secret?: unknown };
  const secret = payload.secret;
  const tokenId = typeof payload.token?.id === "string" ? payload.token.id : "";
  if (typeof secret !== "string" || secret.length === 0) {
    throw new SplitchCliError({
      code: "CLI_UNEXPECTED_ERROR",
      causeSummary: "The response carried no token secret to write",
      remediation: `Revoke the token with splitch tokens revoke ${tokenId || "<token id>"} and retry`,
    });
  }
  try {
    await writeSecret(secret, target);
  } catch (error) {
    throw await writeFailure(error, target, tokenId, onWriteFailure);
  }
  return {
    ...payload,
    secret: null,
    secretWrittenTo: target.path,
    secretFormat: target.format,
    ...(target.format === "env" ? { envVar: target.envVar } : {}),
  };
}

async function writeFailure(
  error: unknown,
  target: PersonalAccessTokenSecretTarget,
  tokenId: string,
  revoke: (tokenId: string) => Promise<boolean>,
): Promise<SplitchCliError> {
  const revoked = tokenId ? await revoke(tokenId).catch(() => false) : false;
  return new SplitchCliError({
    code: "CLI_UNEXPECTED_ERROR",
    causeSummary: `The token secret could not be written to ${target.path}: ${error instanceof Error ? error.message : String(error)}`,
    remediation: revoked
      ? "The unusable token was revoked; fix the path and run the command again"
      : `Revoke the unusable token with splitch tokens revoke ${tokenId}, then retry`,
    originalError: error,
  });
}

async function writeSecret(secret: string, target: PersonalAccessTokenSecretTarget): Promise<void> {
  const value = target.format === "env" ? `${target.envVar}=${secret}` : secret;
  if (!existsSync(target.path)) {
    await writeFile(target.path, `${value}\n`, { mode: 0o600, flag: "wx" });
    return;
  }
  if (!target.append) {
    await replaceFileAtomically(target.path, `${value}\n`);
    return;
  }
  const current = await readFile(target.path, "utf8");
  if (definesVariable(current, target.envVar)) {
    await replaceFileAtomically(target.path, replaceVariable(current, target.envVar, secret));
    return;
  }
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  await appendFile(target.path, `${separator}${value}\n`);
}

/**
 * Write a sibling 0600 temp file and rename it over the target, so a crash
 * mid-write never truncates the user's env file or leaves the secret in a file
 * with looser permissions.
 */
async function replaceFileAtomically(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.splitch-${crypto.randomUUID()}`);
  try {
    await writeFile(temp, content, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function definesVariable(content: string, name: string): boolean {
  return content.split("\n").some((line) => definitionPrefix(line, name) !== null);
}

/** The leading whitespace and optional `export ` of a definition line, or null. */
function definitionPrefix(line: string, name: string): string | null {
  return new RegExp(`^([ \\t]*(?:export[ \\t]+)?)${name}[ \\t]*=`).exec(line)?.[1] ?? null;
}

/** Replace the first definition in place (keeping `export`) and drop later duplicates. */
function replaceVariable(content: string, name: string, secret: string): string {
  let replaced = false;
  const kept: string[] = [];
  for (const line of content.split("\n")) {
    const prefix = definitionPrefix(line, name);
    if (prefix === null) {
      kept.push(line);
    } else if (!replaced) {
      kept.push(`${prefix}${name}=${secret}`);
      replaced = true;
    }
  }
  return kept.join("\n");
}

function usage(causeSummary: string, remediation: string): CliErrorDetail {
  return { code: "CLI_USAGE_INVALID", causeSummary, remediation };
}
