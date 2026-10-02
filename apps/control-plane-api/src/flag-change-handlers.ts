import {
  FlagChangeActionSchema,
  FlagChangeTargetTypeSchema,
  parseFlagChangeDiff,
  renderFlagChangeUnifiedDiff,
} from "@splitch/contracts";
import { appScope, type FlagChangeLogRow, type Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { requireAppMember } from "./app-authz";
import {
  assertFlagChangeWindow,
  flagChangeLogFilter,
  flagChangeReadLimit,
  parseChangeCursor,
  parseFlagChangeQuery,
} from "./flag-change-query";
import { pathParam } from "./handler-input";

export function makeFlagChangeHandlers(deps: { repo: Repository }) {
  return {
    async list(args: HandlerArgs<unknown>): Promise<Response> {
      return readChanges(deps, args, { export: false });
    },
    async export(args: HandlerArgs<unknown>): Promise<Response> {
      return readChanges(deps, args, { export: true });
    },
  };
}

async function readChanges(
  deps: { repo: Repository },
  { input, principal, requestId }: HandlerArgs<unknown>,
  mode: { export: boolean },
): Promise<Response> {
  const appId = pathParam(input, "appId");
  const memberError = await requireAppMember(deps, appId, principal, requestId);
  if (memberError) return memberError;
  const query = parseFlagChangeQuery(input);
  const windowError = assertFlagChangeWindow(query, mode.export);
  if (windowError) {
    return renderError(
      {
        code: "VALIDATION_ERROR",
        message: windowError,
        details: { issues: [{ path: ["query"], message: windowError }] },
      },
      { requestId },
    );
  }
  const cursorSeq = parseChangeCursor(query.cursor);
  if (cursorSeq === "invalid") {
    return renderError(
      {
        code: "INVALID_PAGINATION",
        message: "pagination cursor is not a change-log seq",
        details: { field: "cursor", reason: "unknown cursor" },
      },
      { requestId },
    );
  }
  const order = mode.export ? "asc" : "desc";
  const limit = flagChangeReadLimit(query);
  const scanned = await deps.repo.flagChangeEvents.listForApp(
    appScope(appId),
    flagChangeLogFilter(query, cursorSeq, order, limit + 1),
  );
  const truncated = scanned.length > limit;
  const page = truncated ? scanned.slice(0, limit) : scanned;
  const items = page.map(toEntry);
  const next = truncated ? String(page[page.length - 1]?.seq) : null;
  const body = {
    items,
    readLimit: limit,
    readTruncated: truncated,
    cursor: next,
  };
  if (!mode.export) return Response.json(body);
  return Response.json({
    ...body,
    format: query.format ?? "json",
    unifiedDiff: renderFlagChangeUnifiedDiff(items),
  });
}

function toEntry(row: FlagChangeLogRow) {
  const action = parseEnum(FlagChangeActionSchema, row.action, "action");
  const targetType = parseEnum(FlagChangeTargetTypeSchema, row.targetType, "target_type");
  return {
    seq: row.seq,
    appId: row.appId,
    environmentId: row.environmentId,
    flagId: row.flagId,
    flagKey: row.flagKey,
    action,
    targetType,
    actorRef: row.actorRef,
    actorVia: row.actorVia,
    changedAt: row.changedAt,
    diff: parseFlagChangeDiff(row.diffJson, action),
  };
}

function parseEnum<T>(schema: { parse: (value: unknown) => T }, value: string, field: string): T {
  try {
    return schema.parse(value);
  } catch {
    throw new Error(`flag-change-handlers: stored ${field} "${value}" is not a known value`);
  }
}
