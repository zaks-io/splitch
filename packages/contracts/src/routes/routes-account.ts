import { z } from "@hono/zod-openapi";
import { UserSchema } from "../leaf-schemas-runtime";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import {
  CreateOrganizationRequestSchema,
  OrganizationResponseSchema,
  PatchOrganizationRequestSchema,
} from "../resource-envelopes-account";
import { appEnvironmentRoutes } from "./routes-app-environment";
import {
  AddMemberRequestSchema,
  OrgMemberParams,
  OrgParams,
  UpdateMemberRequestSchema,
} from "./route-shapes";

/**
 * Organization, member, App, and Environment management routes — all on the
 * Control Plane API Worker, control-plane token + control-plane-actor rate class.
 * Endpoint canon: docs/spec/control-plane/endpoints-org-app.md.
 */

const OWNER = "control-plane-api" as const;
const AUTH = "control-plane-token" as const;
const RATE = "control-plane-actor" as const;

const OrgListResponse = z.object({ items: z.array(OrganizationResponseSchema) });
const MemberListResponse = z.object({ items: z.array(UserSchema) });
const MemberResponse = UserSchema;
const DeletedResponse = z.object({ deleted: z.literal(true) });

const organizationRoutes = [
  defineApiRoute({
    operationId: "organizations_list",
    owner: OWNER,
    method: "GET",
    path: "/orgs",
    summary: "List organizations the token can reach (agent cold-start entry).",
    response: OrgListResponse,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: [],
  }),
  // Collection path is `/orgs`, matching every other Organization route. The
  // creating principal becomes `owner` in the same transaction, so this is the
  // one Organization route with no `:orgId` to co-scope against: authorization
  // is the handler's job (a provisional principal must not mint Organizations).
  defineApiRoute({
    operationId: "organizations_create",
    owner: OWNER,
    method: "POST",
    path: "/orgs",
    summary: "Create an organization; the calling principal becomes its owner.",
    request: { body: CreateOrganizationRequestSchema },
    response: OrganizationResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    // "none" until replay semantics exist. Declaring "optional" would expose an
    // `Idempotency-Key` header through every derived client and the OpenAPI
    // document while the handler ignores it, so a retry after a lost response
    // would answer SLUG_CONFLICT instead of replaying the original success:
    // a guarantee advertised but not kept.
    idempotency: "none",
    errors: ["VALIDATION_ERROR", "FORBIDDEN", "SLUG_CONFLICT"],
  }),
  defineApiRoute({
    operationId: "organizations_get",
    owner: OWNER,
    method: "GET",
    path: "/orgs/:orgId",
    summary: "Get one organization.",
    request: { params: OrgParams },
    response: OrganizationResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["ORGANIZATION_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "organizations_update",
    owner: OWNER,
    method: "PATCH",
    path: "/orgs/:orgId",
    summary: "Rename an organization or change its plan.",
    request: { params: OrgParams, body: PatchOrganizationRequestSchema },
    response: OrganizationResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["ORGANIZATION_NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR"],
  }),
  defineApiRoute({
    operationId: "organizations_delete",
    owner: OWNER,
    method: "DELETE",
    path: "/orgs/:orgId",
    summary: "Delete an organization (requires a prior dry-run confirmation token).",
    request: { params: OrgParams },
    response: DeletedResponse,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: [
      "ORGANIZATION_NOT_FOUND",
      "FORBIDDEN",
      "PRIVACY_CONFIRMATION_REQUIRED",
      "SERVICE_UNAVAILABLE",
    ],
  }),
  defineApiRoute({
    operationId: "organization_members_list",
    owner: OWNER,
    method: "GET",
    path: "/orgs/:orgId/members",
    summary: "List organization members.",
    request: { params: OrgParams },
    response: MemberListResponse,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["ORGANIZATION_NOT_FOUND", "USER_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "organization_members_add",
    owner: OWNER,
    method: "POST",
    path: "/orgs/:orgId/members",
    summary: "Add a member to an organization.",
    request: { params: OrgParams, body: AddMemberRequestSchema },
    response: MemberResponse,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["ORGANIZATION_NOT_FOUND", "FORBIDDEN", "USER_NOT_FOUND", "VALIDATION_ERROR"],
  }),
  defineApiRoute({
    operationId: "organization_members_update",
    owner: OWNER,
    method: "PATCH",
    path: "/orgs/:orgId/members/:userId",
    summary: "Change a member's role.",
    request: { params: OrgMemberParams, body: UpdateMemberRequestSchema },
    response: MemberResponse,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: [
      "ORGANIZATION_NOT_FOUND",
      "USER_NOT_FOUND",
      "FORBIDDEN",
      "LAST_OWNER_REQUIRED",
      "VALIDATION_ERROR",
    ],
  }),
  defineApiRoute({
    operationId: "organization_members_remove",
    owner: OWNER,
    method: "DELETE",
    path: "/orgs/:orgId/members/:userId",
    summary: "Remove a member (rejected if removing the last owner).",
    request: { params: OrgMemberParams },
    response: DeletedResponse,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["ORGANIZATION_NOT_FOUND", "USER_NOT_FOUND", "FORBIDDEN", "LAST_OWNER_REQUIRED"],
  }),
] as const satisfies readonly ApiRouteContract[];

/**
 * Still the single list every derived surface (MCP tools, CLI, SDK, OpenAPI)
 * reads. The App/Environment half lives in its own file for size only; splitting
 * the EXPORT would have silently dropped those routes from every surface.
 */
export const accountRoutes = [
  ...organizationRoutes,
  ...appEnvironmentRoutes,
] as const satisfies readonly ApiRouteContract[];
