/**
 * The Org-scoped sections that hang off `/{orgSlug}`. Registered here rather
 * than inlined in the shell so a new Org screen is added in one place, the same
 * way `app-shell-navigation.ts` holds the App-scoped sections.
 *
 * Membership and role are still the Worker's call on a direct deep link: this
 * list decides what is offered, never what is allowed.
 */
export const orgSectionRegistry = [
  { label: "Apps", to: "/$orgSlug", exact: true },
  { label: "Members", to: "/$orgSlug/members", exact: false },
] as const;
