import { SlugSchema, deriveSlug } from "./slug";

/**
 * Organization URL handle rules (SPL-171).
 *
 * The slug is persisted on `organizations` and is what the Control Panel routes
 * on (`/:orgSlug/...`). It lives here rather than in either Worker because the
 * create path validates it and the Panel resolves it, and the two must not be
 * able to disagree about what a valid handle is.
 *
 * Reserved words cover the Panel's own top-level path segments: an Organization
 * slugged `auth` would shadow `/auth/login` and make that route unreachable for
 * everyone, so it is rejected at creation rather than discovered as a routing
 * bug later. `claim` is the one that bites hardest — `/claim/consent/:attemptId`
 * is the claim ceremony, and `/:orgSlug/claim` already exists, so an Org slugged
 * `claim` lands adjacent to the flow that converts a provisional workspace into
 * a real account.
 *
 * The rest are a deliberate superset: words the Panel does not route on today but
 * would plausibly claim later (`billing`, `settings`, `admin`). Reserving one
 * early costs a caller a rename; reserving it after an Org owns it costs a
 * migration. `organization-slug.test.ts` pins the router half of this, so a new
 * top-level route cannot silently escape the list.
 */

export const RESERVED_ORGANIZATION_SLUGS: readonly string[] = [
  "api",
  "auth",
  "claim",
  "kitchen-sink",
  "admin",
  "assets",
  "static",
  "public",
  "login",
  "logout",
  "signup",
  "register",
  "settings",
  "account",
  "billing",
  "docs",
  "help",
  "support",
  "status",
  "health",
  "new",
  "orgs",
  "organizations",
  "apps",
  "internal",
  "splitch",
];

export function isReservedOrganizationSlug(slug: string): boolean {
  return RESERVED_ORGANIZATION_SLUGS.includes(slug);
}

export const OrganizationSlugSchema = SlugSchema.refine(
  (slug) => !isReservedOrganizationSlug(slug),
  { message: "slug is reserved" },
);

/** {@link deriveSlug}, additionally refusing the Panel's reserved route segments. */
export function deriveOrganizationSlug(name: string): string | null {
  const slug = deriveSlug(name);
  return slug && isReservedOrganizationSlug(slug) ? null : slug;
}
