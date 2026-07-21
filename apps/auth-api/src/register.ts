import { appScope, type Repository } from "@splitch/db";
import type { RateLimiter } from "./rate-limit";
import type { TokenSigner } from "./token-exchange";
import type { TurnstilePort } from "./turnstile";
import type { WorkOsPort } from "./workos";

/**
 * Door B: anonymous / pre-claim register (auth-doors.md, ADR-0034).
 *
 * A public, unauthenticated WRITE surface. The order of operations is the whole
 * security argument and is NON-NEGOTIABLE (fail-loud):
 *
 *   1. Turnstile siteverify              ─┐ BEFORE any row is written. A failure
 *   2. per-IP + global rate ceiling      ─┘ throws and ZERO rows are created.
 *   3. create a provisional WorkOS user (unverified email placeholder)
 *   4. create a provisional Org (is_provisional=1, demo_expires_at = now+24h)
 *   5. create a provisional App under it, + its default Environments
 *   6. issue an identity_assertion scoped to pre_claim_scopes = [app:{app_id}:member]
 *
 * NO OTP is issued here: a provisional user has no email yet, so a register-time
 * code could only prove "knows user X's code", never "controls email Y". The OTP
 * is sent to the CLAIMED email at claim-initiation (see claim.ts), which is what
 * actually proves possession of the address being claimed.
 *
 * Every D1 write goes through the @splitch/db repo seam (createRepository) — never
 * a raw client. The Org/App/Org-membership are org-or-identity-scoped writes; the
 * Environments are app-scoped and routed through the scope-bound table so they
 * land under exactly the App just minted.
 */

const DEMO_TTL_MS = 24 * 60 * 60 * 1000; // 24h provisional demo window
const DEFAULT_ENVIRONMENTS = ["production", "development"] as const;

export interface RegisterDeps {
  repo: Repository;
  turnstile: TurnstilePort;
  rateLimiter: RateLimiter;
  workos: WorkOsPort;
  tokenSigner: TokenSigner;
  now: () => number;
}

export interface RegisterInput {
  turnstileToken: string | undefined;
  remoteIp: string | undefined;
}

export interface RegisterResult {
  identity_assertion: string;
  user_id: string;
  org_id: string;
  app_id: string;
  demo_expires_at: string;
}

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** pre-claim scope grant: member on the freshly-minted App only (auth-doors.md step 5). */
function preClaimScopes(appId: string): string[] {
  return [`app:${appId}:member`];
}

export async function registerAnonymous(
  deps: RegisterDeps,
  input: RegisterInput,
): Promise<RegisterResult> {
  // (1) + (2): challenge + ceiling, BEFORE any write. Either throws → zero rows.
  const nowMs = deps.now();
  await deps.turnstile.assertValid(input.turnstileToken, input.remoteIp);
  deps.rateLimiter.assertUnderCeiling(input.remoteIp ?? "unknown", nowMs);

  const nowIso = new Date(nowMs).toISOString();
  const demoExpiresAt = new Date(nowMs + DEMO_TTL_MS).toISOString();

  // (3) provisional WorkOS user — no verified email until the claim ceremony.
  const userId = await deps.workos.createProvisionalUser();

  // (4) provisional Org. is_provisional=1 ⇒ demo_expires_at NOT NULL (invariant).
  const orgId = shortId("org");
  await deps.repo.identity.createOrganization({
    id: orgId,
    name: "Provisional workspace",
    plan: "free",
    isProvisional: true,
    demoExpiresAt,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  await deps.repo.identity.createOrgMembership({
    orgId,
    userId,
    role: "owner",
    createdAt: nowIso,
  });

  // (5) provisional App under the Org, + its default Environments (per-App).
  const appId = shortId("app");
  await deps.repo.identity.createApp({
    id: appId,
    organizationId: orgId,
    name: "Provisional app",
    key: appId,
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: userId,
  });
  await deps.repo.identity.createAppMembership({
    appId,
    userId,
    role: "owner",
    createdAt: nowIso,
  });
  for (const key of DEFAULT_ENVIRONMENTS) {
    await deps.repo.identity.environments.insert(appScope(appId), {
      id: shortId("env"),
      appId,
      key,
      name: key,
      createdAt: nowIso,
      updatedAt: nowIso,
      createdBy: userId,
    });
  }

  // (6) pre-claim assertion: member on this App only, nothing org-wide.
  const assertion = await deps.tokenSigner.mintIdentityAssertion(
    userId,
    preClaimScopes(appId),
    "anonymous",
    Math.floor(nowMs / 1000),
  );

  return {
    identity_assertion: assertion,
    user_id: userId,
    org_id: orgId,
    app_id: appId,
    demo_expires_at: demoExpiresAt,
  };
}
