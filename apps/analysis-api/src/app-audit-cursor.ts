import { type AppAuditListQuery, canonicalJson } from "@splitch/contracts";
import { rowObject, stringField } from "./results-row-fields";

export class InvalidAuditPagination extends Error {}

interface AuditPosition {
  timestamp: string;
  eventId: string;
}

function filterIdentity(appId: string, query: AppAuditListQuery): string {
  const { cursor: _cursor, limit: _limit, ...filters } = query;
  return canonicalJson({ appId, ...filters });
}

export function encodeAuditCursor(
  appId: string,
  query: AppAuditListQuery,
  position: AuditPosition,
): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      filters: filterIdentity(appId, query),
      timestamp: position.timestamp,
      eventId: position.eventId,
    }),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeAuditCursor(appId: string, query: AppAuditListQuery): AuditPosition | null {
  if (!query.cursor) return null;
  try {
    const base64 = query.cursor.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const parsed = rowObject(JSON.parse(new TextDecoder().decode(bytes)));
    if (
      Object.keys(parsed).sort().join(",") !== "eventId,filters,timestamp" ||
      stringField(parsed, "filters") !== filterIdentity(appId, query)
    )
      throw new Error();
    const timestamp = stringField(parsed, "timestamp");
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp) ||
      !Number.isFinite(Date.parse(timestamp))
    )
      throw new Error();
    return { timestamp, eventId: stringField(parsed, "eventId") };
  } catch {
    throw new InvalidAuditPagination("Audit cursor is invalid for this App and filters");
  }
}
