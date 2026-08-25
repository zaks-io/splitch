import { SplitchCliError } from "./errors.js";

export function cloudflareUsage(message: string, originalError?: unknown): SplitchCliError {
  return new SplitchCliError({
    code: "CLI_VALIDATION_ERROR",
    causeSummary: message,
    remediation: "Correct the Cloudflare setup requirement and retry the same command",
    originalError,
  });
}
