import { OAuthError } from "./oauth-errors";

/**
 * Canonical email normalization for the claim ceremony.
 *
 * WHY this exists and why it is its OWN module: the claim collision check
 * (account-takeover defense) and the verify-email write MUST key on the EXACT
 * SAME canonical string, or they disagree and a variant slips past the collision
 * lookup while still verifying a near-identical address. So normalization is
 * single-sourced here and applied ONCE, up front, before either uses the value.
 *
 * Canonicalization rules (deliberately conservative — fail-loud, not clever):
 *  - exactly one `@`; non-empty local + domain (a malformed address is rejected,
 *    never silently coerced).
 *  - the DOMAIN is lowercased and IDN-folded to ASCII (punycode) via the URL
 *    parser, so `eхample.com` (Cyrillic) and `xn--…` resolve to one string —
 *    a homograph domain cannot dodge the collision lookup.
 *  - the LOCAL part is lowercased. We do NOT strip `+tags` or dots: folding them
 *    is provider-specific (Gmail does, most do not), and folding a provider that
 *    does NOT treat them as equal would MERGE two genuinely distinct mailboxes —
 *    the worse failure on a takeover surface. The collision lookup therefore
 *    treats `a+x@host` and `a@host` as DISTINCT; the binding defense (the OTP must
 *    be delivered to and proven for the exact claimed address) is what actually
 *    prevents claiming an address you do not control, not local-part folding.
 *
 * The same canonical form feeds the OTP binding, the collision lookup, and the
 * verify-email write, so all three can never disagree.
 */
export function normalizeEmail(raw: string): string {
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) {
    throw new OAuthError("invalid_request", "email is not a valid address");
  }
  const local = raw.slice(0, at).trim().toLowerCase();
  const domainRaw = raw.slice(at + 1).trim();
  if (!local || /\s/.test(local)) {
    throw new OAuthError("invalid_request", "email local part is invalid");
  }
  const domain = foldDomain(domainRaw);
  return `${local}@${domain}`;
}

/** Lowercase + IDN-to-ASCII the domain via the URL parser (punycode folding). */
function foldDomain(domain: string): string {
  if (!domain || /\s/.test(domain) || domain.includes("@")) {
    throw new OAuthError("invalid_request", "email domain is invalid");
  }
  try {
    // The URL host setter applies the WHATWG host parser, which lowercases and
    // punycode-encodes an IDN host — the canonical ASCII form a registry keys on.
    const url = new URL("http://placeholder");
    url.hostname = domain;
    const host = url.hostname;
    if (!host.includes(".")) {
      throw new OAuthError("invalid_request", "email domain must be fully qualified");
    }
    return host;
  } catch (cause) {
    if (cause instanceof OAuthError) {
      throw cause;
    }
    throw new OAuthError("invalid_request", "email domain is invalid");
  }
}
