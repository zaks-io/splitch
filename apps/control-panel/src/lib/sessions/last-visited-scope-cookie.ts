import { setResponseHeader } from "@tanstack/react-start/server";
import {
  type LastVisitedScope,
  parseLastVisitedCookie,
  recordOrgVisit,
  serializeLastVisitedCookie,
} from "#lib/sessions/last-visited-scope";

// Server-only: `setResponseHeader` must stay out of the client bundle, so call
// these from server function handlers only, where the Start compiler strips the
// reference before bundling the client.

export function writeLastVisitedCookie(value: LastVisitedScope) {
  setResponseHeader("set-cookie", serializeLastVisitedCookie(value));
}

/**
 * Called from a server function that has already authorized `actorId`'s
 * membership in `orgId`; it only writes the hint cookie.
 */
export function rememberOrganizationVisit(request: Request, actorId: string, orgId: string) {
  const existing = parseLastVisitedCookie(request.headers.get("cookie"), actorId);
  writeLastVisitedCookie(recordOrgVisit(existing, actorId, orgId));
}
