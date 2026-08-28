import type { TokenMembershipAccess } from "../src/token-membership";

export const membershipAccessWithoutWideResolution: TokenMembershipAccess = {
  authorize: async () => true,
  resolve: async () => {
    throw new Error("test fixture has no wide membership resolver");
  },
};
