import {
  deriveOrganizationSlug,
  isProvisionalAuthDoor,
  OrganizationSlugSchema,
} from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import type { HandlerArgs, Principal } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { randomHex } from "./credential-cache";
import { objectBody } from "./handler-input";
import { organizationResponse } from "./org-response";

/**
 * `organizations_create` (SPL-171).
 *
 * This is the one Organization route with no `:orgId` path param, so the guard's
 * co-scope check never fires and authorization is entirely this handler's job.
 * There is nothing to check membership against yet — the Org does not exist —
 * so the only question is whether this principal is allowed to become an
 * Organization owner at all.
 *
 * A PROVISIONAL principal is not. It came through the anonymous door: nobody
 * proved an identity, and the token was minted by an unauthenticated
 * `POST /register`. Letting it create Organizations would make unbounded
 * Organization creation an unauthenticated operation.
 *
 * The gate is on the TOKEN's door, not on `org.isProvisional`. Someone who has
 * proved an identity may create Organizations even while one of theirs is still
 * unclaimed — identity is the thing being demanded here, not claim state. So the
 * ceremony named in the rejection is the way to acquire an identified token, not
 * a cleanup chore attached to the old Organization.
 */

interface OrgCreateDeps {
  repo: Repository;
  nowIso?: () => string;
}

export function makeCreateOrganizationHandler(deps: OrgCreateDeps) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    const rejection = provisionalRejection(principal, requestId);
    if (rejection) return rejection;

    const body = objectBody(input);
    const name = body.name as string;
    const slug = resolveSlug(body, name);
    if (!slug) return unusableSlug(name, requestId);

    const now = deps.nowIso?.() ?? new Date().toISOString();
    const created = await deps.repo.identity.createOrganization({
      organization: {
        id: `org_${randomHex(12)}`,
        name,
        slug,
        plan: "free",
        // An Org created by an identified principal is real, never a demo, so it
        // is not eligible for the provisional reaper.
        isProvisional: false,
        demoExpiresAt: null,
        createdAt: now,
        updatedAt: now,
      },
      ownerUserId: principal.id,
      createdAt: now,
    });

    if (!created.ok) return slugConflict(slug, requestId);
    return Response.json(organizationResponse(created.organization), { status: 201 });
  };
}

/**
 * An explicit `slug` is already schema-validated by the guard; derivation is the
 * fallback and can legitimately fail, so it returns null rather than inventing
 * a handle the caller never chose.
 */
function resolveSlug(body: Record<string, unknown>, name: string): string | null {
  if (typeof body.slug === "string") {
    const parsed = OrganizationSlugSchema.safeParse(body.slug);
    return parsed.success ? parsed.data : null;
  }
  return deriveOrganizationSlug(name);
}

function provisionalRejection(principal: Principal, requestId: string): Response | null {
  if (!isProvisionalAuthDoor(principal.authDoor)) return null;
  return renderError(
    {
      code: "FORBIDDEN",
      message:
        "a provisional (anonymous) principal cannot create Organizations; complete the claim ceremony at POST /api/auth/claim/start to obtain an identified principal first",
      details: {},
    },
    { requestId },
  );
}

function unusableSlug(name: string, requestId: string): Response {
  return renderError(
    {
      code: "VALIDATION_ERROR",
      message: `no URL handle could be derived from name "${name}"; supply an explicit "slug"`,
      details: { issues: [{ path: ["slug"], message: "could not be derived from name" }] },
    },
    { requestId },
  );
}

function slugConflict(slug: string, requestId: string): Response {
  return renderError(
    {
      code: "SLUG_CONFLICT",
      message: `URL handle "${slug}" is already taken`,
      details: {
        resourceType: "organization",
        conflictingSlug: slug,
        recommendedAction: "CHOOSE_DIFFERENT_SLUG",
      },
    },
    { requestId },
  );
}
