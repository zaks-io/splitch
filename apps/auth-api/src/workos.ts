import { normalizeEmail } from "./email";

/**
 * WorkOS user-store port.
 *
 * Door A resolves a WorkOS user by verified email, creating one on first sight
 * (auth-doors.md step 8). Door B (anonymous register) instead mints a user with
 * NO verified email yet (an unverified placeholder), and the claim ceremony later
 * binds + verifies a real email. An agent is never a distinct principal — it
 * resolves to a real, persistent WorkOS user. splitch D1 stores membership
 * references only, so this port returns the opaque `user_id` and nothing PII
 * lands in D1.
 *
 * LOCAL FIXTURE: there is no real IdP locally, so the fixture implementation
 * keeps an in-memory email -> user_id map and mints deterministic ids. The real
 * implementation (a WorkOS SDK call) swaps in behind this same port without
 * touching the door logic — the deletion test passes (door logic depends on the
 * interface, fixture and real are two adapters).
 */

export interface WorkOsPort {
  /** Resolve a user_id for a verified email, creating the user if first-seen. */
  resolveOrCreateUser(email: string): Promise<string>;
  /** Mint a fresh anonymous user with NO verified email yet (Door B register). */
  createProvisionalUser(): Promise<string>;
  /**
   * The user_id of an EXISTING verified user for this email, or null. Used by the
   * claim ceremony to detect a collision (account-takeover prevention): a claim
   * whose email already maps to a real user must NEVER silently merge.
   */
  findVerifiedUserByEmail(email: string): Promise<string | null>;
  /** WorkOS owns delivery and verification of the OTP. */
  sendEmailVerification(userId: string, email: string): Promise<void>;
  confirmEmailVerification(userId: string, email: string, otp: string): Promise<void>;
}

/** Stable, opaque user id from a canonical email (deterministic so re-auth returns the same id). */
function fixtureUserId(canonicalEmail: string): string {
  const slug = canonicalEmail.replace(/[^a-z0-9]+/g, "_");
  return `user_fixture_${slug}`;
}

/** The local fixture WorkOS store. First-seen emails create a deterministic user. */
export function makeFixtureWorkOs(): WorkOsPort {
  // canonical email -> user_id for VERIFIED emails only. The index keys on the
  // SAME normalizeEmail() canonical form the claim collision check uses, so a
  // Unicode/punycode (or case) variant of one mailbox can never miss the lookup
  // and slip past the takeover check (Finding 2). A provisional user is absent
  // here until its claim verifies an email, so a pre-claim collision check is clean.
  const verifiedByEmail = new Map<string, string>();
  let anonSeq = 0;

  return {
    async resolveOrCreateUser(email) {
      const canonical = normalizeEmail(email);
      const id = fixtureUserId(canonical);
      verifiedByEmail.set(canonical, id);
      return id;
    },

    async createProvisionalUser() {
      anonSeq += 1;
      return `user_anon_${anonSeq}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    },

    async findVerifiedUserByEmail(email) {
      return verifiedByEmail.get(normalizeEmail(email)) ?? null;
    },

    async sendEmailVerification() {},

    async confirmEmailVerification(userId, email, otp) {
      if (otp !== "000000") throw new Error("WorkOS email verification rejected the code");
      const canonical = normalizeEmail(email);
      if (!verifiedByEmail.has(canonical)) verifiedByEmail.set(canonical, userId);
    },
  };
}

/** Hosted WorkOS adapter. OTP values only transit to WorkOS; they are never logged or persisted. */
export function makeHostedWorkOs(input: { apiKey: string; baseUrl?: string }): WorkOsPort {
  if (!input.apiKey) throw new Error("WORKOS_API_KEY is required for the hosted WorkOS adapter");
  const baseUrl = input.baseUrl ?? "https://api.workos.com";
  return {
    async resolveOrCreateUser(email) {
      const existing = await findUser(email);
      if (existing) return existing;
      const response = await request("/user_management/users", "POST", {
        email,
        email_verified: true,
      });
      return userId(response);
    },
    async createProvisionalUser() {
      const email = `unclaimed+${crypto.randomUUID()}@invalid.splitch.dev`;
      const response = await request("/user_management/users", "POST", {
        email,
        email_verified: false,
      });
      return userId(response);
    },
    findVerifiedUserByEmail: findUser,
    async sendEmailVerification(userId, email) {
      await request(`/user_management/users/${encodeURIComponent(userId)}`, "PUT", {
        email,
        email_verified: false,
      });
      await request(
        `/user_management/users/${encodeURIComponent(userId)}/email_verification/send`,
        "POST",
      );
    },
    async confirmEmailVerification(userId, _email, otp) {
      await request(
        `/user_management/users/${encodeURIComponent(userId)}/email_verification/confirm`,
        "POST",
        { code: otp },
      );
    },
  };

  async function findUser(email: string): Promise<string | null> {
    const response = await request(
      `/user_management/users?email=${encodeURIComponent(email)}`,
      "GET",
      undefined,
      true,
    );
    if (!response) return null;
    const data = Array.isArray(response.data) ? response.data : [];
    const user = data[0];
    return user && typeof user.id === "string" && user.email_verified === true ? user.id : null;
  }

  async function request(
    path: string,
    method: string,
    body?: object,
    allowNotFound = false,
  ): Promise<Record<string, any> | null> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) throw new Error(`WorkOS user management request failed (${response.status})`);
    return (await response.json()) as Record<string, any>;
  }
}

function userId(response: Record<string, any> | null): string {
  if (!response || typeof response.id !== "string")
    throw new Error("WorkOS user response missing id");
  return response.id;
}
