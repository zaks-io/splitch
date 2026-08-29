import { emit } from "./execute-io.js";
import type { CliIo } from "./execute-types.js";
import {
  assertHydratedFlagRead,
  assertHydratedPrincipalFlagRead,
  formatFlagRead,
} from "./format-flag-read.js";
import { formatPrincipalFlags } from "./format-principal-flags.js";
import type { ParsedInvocation } from "./parse-args.js";

/**
 * Stdout rendering for successful operation responses. Split from
 * `execute-operations.ts` so that file stays under the file-size ratchet (300
 * code lines); the Flag reads are the only operations whose output shape
 * depends on more than `--json`.
 */

export function emitApiOutput(
  io: CliIo,
  operationId: string,
  payload: unknown,
  invocation: ParsedInvocation,
): void {
  if (operationId === "principal_flags_list") {
    emitPrincipalFlagOutput(io, payload, invocation);
    return;
  }
  if (operationId !== "flags_list" && operationId !== "flags_get") {
    emit(io, invocation.flags.json, payload);
    return;
  }
  if (invocation.flags.json) {
    assertHydratedFlagRead(operationId, payload);
    emit(io, true, payload);
    return;
  }
  io.log(formatFlagRead(operationId, payload, invocation.flags.summary));
}

function emitPrincipalFlagOutput(io: CliIo, payload: unknown, invocation: ParsedInvocation): void {
  if (!invocation.flags.summary) assertHydratedPrincipalFlagRead(payload);
  if (invocation.flags.json) {
    emit(io, true, payload);
    return;
  }
  const groupedFlags = formatPrincipalFlags(payload);
  if (groupedFlags) io.log(groupedFlags);
  else emit(io, false, payload);
}
