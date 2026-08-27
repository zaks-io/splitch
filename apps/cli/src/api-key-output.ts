/**
 * `api-keys create` surfaces the raw secret once. Under `--json` that secret is
 * on stdout, so an agent that pipes the command to a log has published a
 * credential it cannot unpublish. `--output-file` keeps it off both streams:
 * the secret lands in one 0600 file and the payload names the path instead.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CliErrorDetail } from "./errors.js";
import { SplitchCliError } from "./errors.js";

/** The one operation whose response carries a secret that is never readable again. */
export const API_KEY_CREATE_OPERATION_ID = "api_keys_create";

export interface ApiKeyCreateFileResult {
  readonly value: null;
  readonly valueWrittenTo: string;
}

/**
 * Checked before the Key is minted: a path that already exists would otherwise
 * cost a live credential that can never be read back.
 */
export function apiKeyOutputPathError(outputFile: string): CliErrorDetail | null {
  const path = resolve(outputFile);
  if (!existsSync(path)) return null;
  return {
    code: "CLI_USAGE_INVALID",
    causeSummary: `--output-file ${path} already exists`,
    remediation: "Pass a path that does not exist yet, or remove the existing file first",
  };
}

export async function writeApiKeySecret(
  data: unknown,
  outputFile: string,
): Promise<Record<string, unknown> & ApiKeyCreateFileResult> {
  const payload = data as Record<string, unknown>;
  const value = payload.value;
  if (typeof value !== "string" || value.length === 0) {
    throw new SplitchCliError({
      code: "CLI_UNEXPECTED_ERROR",
      causeSummary: "The API Key response carried no secret to write",
      remediation: `Retry without --output-file and read the value field; the Key may already exist as ${String(payload.credential ?? "an unnamed credential")}`,
    });
  }
  const path = resolve(outputFile);
  try {
    // Exclusive create: silently clobbering a file the caller already trusts
    // with a credential is worse than refusing.
    await writeFile(path, `${value}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    throw new SplitchCliError({
      code: "CLI_UNEXPECTED_ERROR",
      causeSummary: `The API Key was created but could not be written to ${path}: ${error instanceof Error ? error.message : String(error)}`,
      remediation:
        "The secret is not recoverable. Revoke the Key with `splitch api-keys revoke` and re-run against a path that does not exist yet",
      originalError: error,
    });
  }
  return { ...payload, value: null, valueWrittenTo: path };
}
