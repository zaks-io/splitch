import type { EventDefinition, EventDefinitionVersion } from "@splitch/contracts";
import type { ValidationIssue } from "./metric-event-validation";

/**
 * Trusted operator-only record of an Event Definition mismatch. The public
 * Client Key response must never include this payload.
 */
export interface EventDefinitionMismatchDiagnostic {
  readonly eventName: string;
  readonly eventDefinitionId: string;
  readonly eventDefinitionVersionId: string;
  readonly eventDefinition: EventDefinition;
  readonly version: EventDefinitionVersion;
  readonly originalIssues: readonly ValidationIssue[];
}

export type EventDefinitionMismatchSink = (diagnostic: EventDefinitionMismatchDiagnostic) => void;

/** Untruncated operator sink. Pass the object through so nothing is sliced. */
export function recordEventDefinitionMismatch(diagnostic: EventDefinitionMismatchDiagnostic): void {
  console.error("event-ingest-api event definition mismatch", diagnostic);
}
