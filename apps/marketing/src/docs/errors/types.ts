import type { CliClientErrorCode } from "@splitch/cli";
import type { ErrorCode } from "@splitch/contracts";
import type { SdkClientErrorCode } from "@splitch/sdk";

/**
 * Every failure code a caller can observe: the wire contract plus the two
 * client-only families. `/docs/error/{code}` publishes one page per member, so
 * the catalog below is keyed by this union and the compiler refuses a gap.
 */
export type DocumentedErrorCode = ErrorCode | SdkClientErrorCode | CliClientErrorCode;

export type ErrorSurface = "api" | "sdk" | "cli";

export interface ErrorDoc {
  /**
   * One imperative sentence, short enough to print on a terminal line and read
   * aloud in an MCP result. Required on every wire `ErrorCode` and absent on the
   * `SDK_`/`CLI_` families, whose remediation is written at the call site that
   * raises them: that site can name the file, host, or flag involved, and a
   * per-code string here would replace specific copy with a generic one.
   * Surface-specific instructions (a CLI flag, an MCP argument) belong to the
   * surface, not here.
   */
  readonly remediation?: string;
  /** The condition that produced the code, in one sentence. */
  readonly cause: string;
  /** The next action that clears it. */
  readonly fix: string;
  /** `details` payload shape on the wire. Omitted when the code carries `{}`. */
  readonly details?: string;
  /** Stable `details.recommendedAction` token, when the code carries one. */
  readonly recommendedAction?: string;
  /** Process exit code `splitch` returns for this failure. CLI codes only. */
  readonly exitCode?: number;
  /** Other codes reachable on the same path. */
  readonly related?: readonly DocumentedErrorCode[];
}
