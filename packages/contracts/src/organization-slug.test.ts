import { describe, expect, it } from "vitest";
import {
  deriveOrganizationSlug,
  isReservedOrganizationSlug,
  ORGANIZATION_SLUG_MAX_LENGTH,
  OrganizationSlugSchema,
} from "./organization-slug";

describe("OrganizationSlugSchema", () => {
  it("accepts lowercase alphanumerics with single internal hyphens", () => {
    for (const slug of ["acme", "acme-labs", "a1", "orbit-tools-2"]) {
      expect(OrganizationSlugSchema.safeParse(slug).success).toBe(true);
    }
  });

  it("rejects handles that would not round-trip through a URL path segment", () => {
    // Uppercase and spaces re-encode; a leading/trailing or doubled hyphen makes
    // two distinct strings render as the same handle to a reader.
    for (const slug of ["Acme", "acme labs", "-acme", "acme-", "acme--labs", "acme_labs", "a"]) {
      expect(OrganizationSlugSchema.safeParse(slug).success).toBe(false);
    }
  });

  it("rejects reserved Panel path segments", () => {
    // An Org slugged `auth` would shadow /auth/login for every user, not just
    // its own members, so this is a platform-wide invariant and not a nicety.
    for (const slug of ["auth", "api", "settings", "orgs"]) {
      expect(isReservedOrganizationSlug(slug)).toBe(true);
      expect(OrganizationSlugSchema.safeParse(slug).success).toBe(false);
    }
  });

  it("rejects a slug longer than the column allows", () => {
    const tooLong = "a".repeat(ORGANIZATION_SLUG_MAX_LENGTH + 1);
    expect(OrganizationSlugSchema.safeParse(tooLong).success).toBe(false);
  });
});

describe("deriveOrganizationSlug", () => {
  it("derives a URL handle from an ordinary display name", () => {
    expect(deriveOrganizationSlug("Acme Labs")).toBe("acme-labs");
    expect(deriveOrganizationSlug("  Orbit__Tools  ")).toBe("orbit-tools");
    expect(deriveOrganizationSlug("Acme / Labs, Inc.")).toBe("acme-labs-inc");
  });

  it("folds accents so a handle stays ASCII", () => {
    expect(deriveOrganizationSlug("Ünïcödé Çorp")).toBe("unicode-corp");
  });

  it("folds accented names onto their unaccented handle", () => {
    // Not a bug to fix in derivation: two Orgs CAN legitimately want these
    // names, and the unique index is what refuses the second one. This test
    // pins the collision so the create path is never written assuming
    // derivation alone guarantees a free slug.
    expect(deriveOrganizationSlug("Åcme Lábs")).toBe(deriveOrganizationSlug("Acme Labs"));
  });

  it("returns null instead of inventing a handle it cannot derive", () => {
    // Fail loud: the caller asks for an explicit slug. Falling back to the Org
    // id would hand back a URL the user never chose and cannot guess.
    expect(deriveOrganizationSlug("🎉🎉")).toBeNull();
    expect(deriveOrganizationSlug("a")).toBeNull();
    expect(deriveOrganizationSlug("   ")).toBeNull();
  });

  it("returns null when a name derives onto a reserved handle", () => {
    expect(deriveOrganizationSlug("Auth")).toBeNull();
    expect(deriveOrganizationSlug("Settings")).toBeNull();
  });

  it("never derives a handle its own schema would reject", () => {
    const names = [
      "Acme Labs",
      "  Orbit__Tools  ",
      "Ünïcödé Çorp",
      "Acme / Labs, Inc.",
      "x".repeat(80),
      "9 Lives",
      "a-b",
    ];
    for (const name of names) {
      const slug = deriveOrganizationSlug(name);
      if (slug === null) continue;
      expect(OrganizationSlugSchema.safeParse(slug).success).toBe(true);
    }
  });
});
