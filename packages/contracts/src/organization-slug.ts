import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, SlugSchema } from "./slug";

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

/** Unicode combining marks (U+0300-U+036F), stripped after NFKD so "Acme" with
 *  a ring above slugs as "acme". Built from code points so the range survives
 *  source-file normalization intact. */
const COMBINING_MARKS = new RegExp(
  `[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`,
  "g",
);

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

/**
 * Best-effort handle from a display name, for when the caller supplies no slug.
 *
 * Returns null rather than a fallback when the name yields nothing usable (an
 * all-emoji name, or one that slugifies to under the minimum). The caller then
 * fails loud and asks for an explicit slug — silently substituting the
 * Organization id would hand back a URL the user never chose and cannot guess.
 */
export function deriveOrganizationSlug(name: string): string | null {
  const slug = name
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");

  if (slug.length < SLUG_MIN_LENGTH) return null;
  if (isReservedOrganizationSlug(slug)) return null;
  return slug;
}
