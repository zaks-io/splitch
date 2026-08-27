import type { EnvironmentPolicy } from "@splitch/sdk/control-plane";
import type { CliIo } from "./execute-types.js";
import { formatEnvironmentPolicy, isEnvironmentPolicy } from "./format-environment-policy.js";

export function emit(io: CliIo, asJson: boolean, payload: unknown): void {
  if (asJson) {
    io.log(JSON.stringify(payload));
    return;
  }
  if (isPolicyProjection(payload)) {
    io.log(formatEnvironmentPolicy(payload.policy));
    return;
  }
  io.log(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
}

function isPolicyProjection(payload: unknown): payload is { policy: EnvironmentPolicy } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    "policy" in payload &&
    isEnvironmentPolicy((payload as { policy: unknown }).policy) &&
    Object.keys(payload).length === 1
  );
}

/**
 * `--json` is parsed per invocation but every error site writes through `CliIo`,
 * so the mode rides on the io rather than being threaded through ~28 call sites.
 */
export function withJsonMode(io: CliIo, json: boolean): CliIo {
  return { ...io, json };
}

export function consoleIo(): CliIo {
  return {
    log: (line) => {
      console.log(line);
    },
    error: (line) => {
      console.error(line);
    },
  };
}
