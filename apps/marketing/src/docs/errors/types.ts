import type { ErrorCode } from "@splitch/contracts";
import type { CliClientErrorCode } from "@splitch/cli";
import type { SdkClientErrorCode } from "@splitch/sdk";

/**
 * Every failure code a caller can observe: the wire contract plus the two
 * client-only families. `/docs/error/{code}` publishes one page per member, so
 * the catalog below is keyed by this union and the compiler refuses a gap.
 */
export type DocumentedErrorCode = ErrorCode | SdkClientErrorCode | CliClientErrorCode;

export type ErrorSurface = "api" | "sdk" | "cli";

export interface ErrorDoc {
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
