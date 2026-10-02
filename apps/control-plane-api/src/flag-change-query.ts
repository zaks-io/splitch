import { LIST_READ_LIMIT, PAGINATION_DEFAULT_LIMIT } from "@splitch/contracts";
import type { FlagChangeLogFilter } from "@splitch/db";

export interface FlagChangeQuery {
  from?: string;
  to?: string;
  environmentId?: string;
  fromEnvironmentId?: string;
  toEnvironmentId?: string;
  flagId?: string;
  limit?: number;
  cursor?: string | null;
  format?: "json" | "unified";
}

export function parseFlagChangeQuery(input: unknown): FlagChangeQuery {
  const query = (input as { query?: unknown }).query;
  return query && typeof query === "object" && !Array.isArray(query)
    ? (query as FlagChangeQuery)
    : {};
}

export function flagChangeReadLimit(query: FlagChangeQuery): number {
  return Math.min(query.limit ?? PAGINATION_DEFAULT_LIMIT, LIST_READ_LIMIT);
}

export function assertFlagChangeWindow(
  query: FlagChangeQuery,
  requireRange: boolean,
): string | null {
  return assertTimeRange(query, requireRange) ?? assertPromotionPair(query);
}

function assertTimeRange(query: FlagChangeQuery, requireRange: boolean): string | null {
  const hasFrom = query.from !== undefined;
  const hasTo = query.to !== undefined;
  if (requireRange && (!hasFrom || !hasTo)) {
    return "from and to are required for a change-log export";
  }
  if (hasFrom !== hasTo) return "from and to must be supplied together";
  if (!hasFrom || !hasTo) return null;
  const fromMs = Date.parse(query.from as string);
  const toMs = Date.parse(query.to as string);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return "from and to must be valid ISO-8601 instants";
  }
  // Offset timestamps can invert under string order while remaining valid
  // wall-clock windows (and the reverse). Compare parsed instants only.
  if (fromMs > toMs) return "to must be at or after from";
  return null;
}

function assertPromotionPair(query: FlagChangeQuery): string | null {
  const hasFromEnv = query.fromEnvironmentId !== undefined;
  const hasToEnv = query.toEnvironmentId !== undefined;
  if (hasFromEnv !== hasToEnv) {
    return "fromEnvironmentId and toEnvironmentId must be supplied together";
  }
  if (hasFromEnv && query.fromEnvironmentId === query.toEnvironmentId) {
    return "toEnvironmentId must differ from fromEnvironmentId";
  }
  if (query.environmentId !== undefined && hasFromEnv) {
    return "environmentId cannot be combined with a promotion Environment pair";
  }
  return null;
}

export function flagChangeLogFilter(
  query: FlagChangeQuery,
  cursorSeq: number | undefined,
  order: "asc" | "desc",
  limit: number,
): FlagChangeLogFilter {
  const promotion =
    query.fromEnvironmentId !== undefined && query.toEnvironmentId !== undefined
      ? [query.fromEnvironmentId, query.toEnvironmentId]
      : undefined;
  return {
    from: query.from,
    to: query.to,
    flagId: query.flagId,
    environmentIds: query.environmentId !== undefined ? [query.environmentId] : promotion,
    includeAppLevel: true,
    afterSeq: order === "asc" ? cursorSeq : undefined,
    beforeSeq: order === "desc" ? cursorSeq : undefined,
    order,
    limit,
  };
}

export function parseChangeCursor(
  cursor: string | null | undefined,
): number | undefined | "invalid" {
  if (cursor === undefined || cursor === null || cursor === "") return undefined;
  if (!/^[1-9][0-9]*$/.test(cursor)) return "invalid";
  const seq = Number(cursor);
  // Digit-only strings still overflow Number: a 309-digit cursor becomes
  // Infinity, and values above MAX_SAFE_INTEGER round before the DB sees them.
  // Require a positive safe integer whose decimal form matches the cursor.
  if (!Number.isSafeInteger(seq) || seq < 1 || String(seq) !== cursor) return "invalid";
  return seq;
}
