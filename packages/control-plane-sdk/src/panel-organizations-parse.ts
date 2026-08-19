/**
 * The Organization-scoped half of the Panel vocabulary: the Organization
 * itself, its membership, and its usage read.
 *
 * `organizations_create` is the one member with no resource to bind against —
 * an Organization that does not exist yet cannot be co-scoped — so that
 * delegation carries only the actor and the Worker decides authorization on its
 * own. Every other member here names the Organization it acts on.
 */

import type { ControlPanelOperation } from "./control-panel-operation.js";
import { decodeSegment, decodedSegments } from "./panel-path-segments.js";

const ORG_USAGE_PATH = /^\/orgs\/([^/]+)\/usage\/?$/;

const ORGANIZATIONS_PATH = /^\/orgs\/?$/;

const ORG_MEMBERS_PATH = /^\/orgs\/([^/]+)\/members\/?$/;

const ORG_MEMBER_PATH = /^\/orgs\/([^/]+)\/members\/([^/]+)\/?$/;

const ORG_MEMBER_COLLECTION_METHODS = {
  GET: "organization_members_list",
  POST: "organization_members_add",
} as const;

const ORG_MEMBER_RESOURCE_METHODS = {
  PATCH: "organization_members_update",
  DELETE: "organization_members_remove",
} as const;

/**
 * `POST /orgs`. Ordered AFTER `parseAppsCreate` so the two `/orgs…` shapes can
 * never be confused: `APPS_PATH` requires a trailing `/apps` segment and this
 * one requires the collection root, so the patterns are disjoint by construction
 * rather than by ordering luck.
 */
export function parseOrganizationsCreate(
  method: string,
  pathname: string,
): ControlPanelOperation | null {
  return method === "POST" && ORGANIZATIONS_PATH.test(pathname)
    ? { id: "organizations_create" }
    : null;
}

/**
 * The four Org membership operations. The collection and resource patterns are
 * disjoint by construction: the resource one requires a member segment, so a
 * list delegation can never satisfy a per-member mutation.
 */
export function parseOrgMembers(method: string, pathname: string): ControlPanelOperation | null {
  return parseOrgMemberCollection(method, pathname) ?? parseOrgMemberResource(method, pathname);
}

function parseOrgMemberCollection(method: string, pathname: string): ControlPanelOperation | null {
  const id = ORG_MEMBER_COLLECTION_METHODS[method as keyof typeof ORG_MEMBER_COLLECTION_METHODS];
  const match = pathname.match(ORG_MEMBERS_PATH);
  const orgId = match?.[1] ? decodeSegment(match[1]) : null;
  return id && orgId ? { id, orgId } : null;
}

function parseOrgMemberResource(method: string, pathname: string): ControlPanelOperation | null {
  const id = ORG_MEMBER_RESOURCE_METHODS[method as keyof typeof ORG_MEMBER_RESOURCE_METHODS];
  const match = pathname.match(ORG_MEMBER_PATH);
  if (!match?.[1] || !match[2]) return null;
  const [orgId, userId] = decodedSegments(match.slice(1, 3));
  return id && orgId && userId ? { id, orgId, userId } : null;
}

/**
 * `GET /orgs/:orgId/usage`. Names the Organization it reads, so the resolver
 * binds the delegation to live Org membership rather than trusting the claim:
 * usage is Organization-wide (ADR-0033), which makes the Org the tenant boundary
 * this read must not cross.
 */
export function parseOrganizationUsage(
  method: string,
  pathname: string,
): ControlPanelOperation | null {
  const match = pathname.match(ORG_USAGE_PATH);
  const orgId = match?.[1] ? decodeSegment(match[1]) : null;
  return method === "GET" && orgId ? { id: "organization_usage_get", orgId } : null;
}
