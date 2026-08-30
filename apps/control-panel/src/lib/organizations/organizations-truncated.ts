export const ORGANIZATIONS_TRUNCATED_DESCRIPTION =
  "You belong to more Organizations than one sign-in session can carry, so this list is cut short. The rest still exist and nothing was deleted, but the Control Panel cannot reach them while they are outside this list.";

export function organizationsTruncatedTitle(limit: number): string {
  return `Showing the first ${limit} of your Organizations`;
}
