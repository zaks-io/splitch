import type { MetricEventTrackRequest } from "@splitch/contracts";
import type { ValidationIssue } from "./metric-event-validation";

export interface PublicValidationIssue {
  readonly path: string[];
  readonly message: string;
}

/**
 * Public Client Key issues may name only caller-owned path segments and use
 * generic copy. Configured field names the caller did not send, expected types,
 * bounds, and allowed values stay off this surface.
 */
export function publicValidationIssues(
  issues: readonly ValidationIssue[],
  parsed: MetricEventTrackRequest,
): PublicValidationIssue[] {
  const seen = new Set<string>();
  const result: PublicValidationIssue[] = [];
  for (const issue of issues) {
    const path = callerOwnedPath(issue.path, parsed);
    const message = publicIssueMessage(issue.message);
    const key = `${path.join("\0")}\0${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ path, message });
  }
  return result;
}

function callerOwnedPath(path: readonly string[], parsed: MetricEventTrackRequest): string[] {
  const [root, ...rest] = path;
  if (root === "idType") return ["idType"];
  if (root !== "fields" && root !== "dimensions") return [];
  return [root, ...ownedSegments(parsed[root], rest)];
}

function ownedSegments(current: unknown, segments: readonly string[]): string[] {
  const [segment, ...rest] = segments;
  if (segment === undefined) return [];
  const next = childAt(current, segment);
  return next === undefined ? [] : [segment, ...ownedSegments(next, rest)];
}

function childAt(current: unknown, segment: string): unknown {
  if (Array.isArray(current)) {
    const index = Number(segment);
    return Number.isInteger(index) && index >= 0 && index in current ? current[index] : undefined;
  }
  if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) {
    return undefined;
  }
  return (current as Record<string, unknown>)[segment];
}

function publicIssueMessage(message: string): string {
  if (
    message.startsWith("number must be at least") ||
    message.startsWith("number must be at most") ||
    message === "number must be finite"
  ) {
    return "number is out of range";
  }
  if (message.startsWith("expected Entity type")) {
    return "idType does not match the Event Definition";
  }
  if (
    message.startsWith("expected ") ||
    message === "required value is missing" ||
    message === "required JSON key is missing" ||
    message === "array is too short" ||
    message === "array is too long"
  ) {
    return "invalid value";
  }
  return message;
}
