/**
 * The actor the MCP OAuth protected-resource tests authenticate as, and the
 * fixed clock they mint tokens against.
 *
 * Its own module because both the harness and the JWT signer need it: importing
 * it from either one would make those two modules circular, which works only
 * until one of them reads the other's binding during evaluation.
 */

export const NOW_SECONDS = 1_800_000_000;

// `actorClaims` mints no `auth_door`, so the verifier resolves the door
// fail-closed to `anonymous` and the delegation carries that downstream.
export const actor = {
  subject: "user_mcp",
  scopes: ["app:app_local:admin"],
  authDoor: "anonymous" as const,
};
