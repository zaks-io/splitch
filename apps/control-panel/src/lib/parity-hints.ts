import { cliCommandString, cliPresentationAliasString, getRoute } from "@splitch/contracts";

/**
 * Agent parity for teaching surfaces.
 *
 * Every empty state promises "you can do this from the terminal or an agent
 * too", and a command that does not exist is a defect, not a typo. So the panel
 * never writes a command string by hand: it names an `operationId` and both
 * skins are derived from the shipped route registry (ADR-0023). An unknown
 * `operationId` throws here rather than rendering a lie.
 */
export interface ParityHint {
  readonly cli: string;
  readonly mcp: string;
}

export function parityHint(operationId: string): ParityHint {
  if (!getRoute(operationId)) {
    throw new Error(`parityHint: "${operationId}" is not a registered operation`);
  }
  return { cli: cliCommandString(operationId), mcp: operationId };
}

/**
 * Verify is the one surface whose two skins do not share an `operationId`. The
 * CLI registers `splitch flags verify` as a presentation alias on `sdk_verify`,
 * while the agent equivalent is `flags_test_eval` — `verify` is not itself an
 * MCP tool. Both halves are still derived, never typed: the CLI half from the
 * shared alias map the CLI itself builds from, the MCP half through
 * `parityHint`, which throws if the tool stops being registered.
 */
export const VERIFY_PARITY: ParityHint = {
  ...parityHint("flags_test_eval"),
  cli: cliPresentationAliasString("sdk_verify"),
};
