import { appScope } from "@splitch/db";
import type { ClaimDeps } from "./claim";
import { normalizeEmail } from "./email";
import { OAuthError } from "./oauth-errors";

export interface Provisional {
  userId: string;
  orgId: string;
  appId: string;
  email: string;
}

export async function resolveIdentity(
  deps: ClaimDeps,
  assertion: string,
  email: string,
  now: number,
): Promise<Provisional> {
  const identity = await deps.tokenSigner.verifyIdentityAssertion(
    assertion,
    Math.floor(now / 1000),
  );
  const appId = identity.scopes
    .map((scope) => scope.split(":"))
    .find((part) => part.length === 3 && part[0] === "app")?.[1];
  if (!appId)
    throw new OAuthError("invalid_grant", "identity_assertion carries no pre-claim App scope");
  const app = await deps.repo.identity.getApp(appId);
  if (!app) throw new OAuthError("invalid_grant", "pre-claim App no longer exists");
  return {
    userId: identity.userId,
    orgId: app.organizationId,
    appId,
    email: normalizeEmail(email),
  };
}

export async function assertClaimMemberships(
  deps: ClaimDeps,
  claimant: Provisional,
): Promise<void> {
  const [orgMembership, appMembership] = await Promise.all([
    deps.repo.identity.getOrgMembership(claimant.orgId, claimant.userId),
    deps.repo.identity.getAppMembership(appScope(claimant.appId), claimant.userId),
  ]);
  if (!orgMembership || !appMembership) {
    throw new OAuthError(
      "invalid_grant",
      "pre-claim Organization and App memberships do not match the identity",
    );
  }
}

export async function claimHashes(userId: string, email: string) {
  return {
    provisionalUserHash: await hashIdentifier(userId),
    emailHash: await hashIdentifier(email),
  };
}

export async function hashIdentifier(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function iso(now: number) {
  return new Date(now).toISOString();
}
