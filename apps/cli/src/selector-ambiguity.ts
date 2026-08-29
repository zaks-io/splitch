import type { ErrorResponse } from "@splitch/sdk/control-plane";
import type { ParsedInvocation } from "./parse-args.js";

const UNSAFE_REPLAY_FLAGS = new Set(["--body-json", "--context-json"]);

export function selectorAmbiguityRemediation(
  error: ErrorResponse,
  invocation: ParsedInvocation | undefined,
): string | null {
  if (error.code !== "SELECTOR_AMBIGUOUS") return null;
  if (error.details.recommendedAction !== "USE_CANONICAL_ID") {
    return "Choose one of the candidates returned by the server and retry with its canonical value";
  }

  const retries = error.details.candidates.map((candidate) => {
    if ("appId" in candidate) {
      return {
        label: `App ${candidate.appSlug} in Organization ${candidate.orgSlug}`,
        command: retryCommand(invocation, "--app", candidate.appId),
      };
    }
    return {
      label: `Environment ${candidate.environmentKey}`,
      command: retryCommand(invocation, "--env", candidate.environmentId),
    };
  });

  return `Choose a candidate and retry: ${retries
    .map(({ label, command }) => `${label}${command ? `: ${command}` : ""}`)
    .join("; ")}`;
}

function retryCommand(
  invocation: ParsedInvocation | undefined,
  selectorFlag: "--app" | "--env",
  canonicalValue: string,
): string | null {
  if (!invocation || containsUnsafeReplayValue(invocation.rawArgs)) return null;
  const args = [...invocation.rawArgs];
  const flagIndex = args.indexOf(selectorFlag);
  if (flagIndex === -1) {
    args.push(selectorFlag, canonicalValue);
  } else {
    args[flagIndex + 1] = canonicalValue;
  }
  return ["splitch", ...args].map(shellQuote).join(" ");
}

function containsUnsafeReplayValue(args: readonly string[]): boolean {
  return args.some((arg) => UNSAFE_REPLAY_FLAGS.has(arg));
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
