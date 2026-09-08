import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CliErrorDetail } from "./errors.js";
import { SplitchCliError } from "./errors.js";

export interface OneTimeSecretDescriptor {
  readonly secretField: "value" | "webhookSecret";
  readonly writtenToField: "valueWrittenTo" | "webhookSecretWrittenTo";
  readonly label: string;
}

const descriptors: Readonly<Record<string, OneTimeSecretDescriptor>> = {
  api_keys_create: {
    secretField: "value",
    writtenToField: "valueWrittenTo",
    label: "API Key",
  },
  sentry_installations_create: {
    secretField: "webhookSecret",
    writtenToField: "webhookSecretWrittenTo",
    label: "Sentry webhook secret",
  },
  sentry_secret_rotations_create: {
    secretField: "webhookSecret",
    writtenToField: "webhookSecretWrittenTo",
    label: "Sentry webhook secret",
  },
};

export function oneTimeSecretDescriptor(operationId: string): OneTimeSecretDescriptor | undefined {
  return descriptors[operationId];
}

export function oneTimeSecretOutputPathError(outputFile: string): CliErrorDetail | null {
  const path = resolve(outputFile);
  if (!existsSync(path)) return null;
  return {
    code: "CLI_USAGE_INVALID",
    causeSummary: `--output-file ${path} already exists`,
    remediation: "Pass a path that does not exist yet, or remove the existing file first",
  };
}

export async function writeOneTimeSecret(
  data: unknown,
  outputFile: string,
  descriptor: OneTimeSecretDescriptor,
): Promise<Record<string, unknown>> {
  const payload = data as Record<string, unknown>;
  const value = payload[descriptor.secretField];
  if (typeof value !== "string" || value.length === 0) {
    throw new SplitchCliError({
      code: "CLI_UNEXPECTED_ERROR",
      causeSummary: `The response carried no ${descriptor.label} to write`,
      remediation: "Inspect the resource response and revoke or rotate it before retrying",
    });
  }
  const path = resolve(outputFile);
  try {
    await writeFile(path, `${value}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    throw new SplitchCliError({
      code: "CLI_UNEXPECTED_ERROR",
      causeSummary: `${descriptor.label} was created but could not be written to ${path}: ${error instanceof Error ? error.message : String(error)}`,
      remediation: "Revoke or rotate the secret, then retry with a path that does not exist",
      originalError: error,
    });
  }
  return {
    ...payload,
    [descriptor.secretField]: null,
    [descriptor.writtenToField]: path,
  };
}
