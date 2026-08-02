import type { ScrubOptions } from "@splitch/privacy";

/**
 * Default bare-value patterns for observability emission.
 *
 * WHY these exist beyond the key-name policy: `@splitch/privacy` redacts by KEY
 * (`authorization`, `token`, `secret`, ...), which reaches nothing that has been
 * flattened into free text. An exception message, a stack frame, or a fault
 * identity is one string under one non-PII key, so key matching is already past
 * it. These patterns are the shapes this platform's credentials actually take,
 * so a secret interpolated into a throw is redacted by what it IS rather than by
 * where it happened to sit.
 *
 * Every quantifier is bounded so worst-case backtracking is capped on
 * adversarial input, matching the ReDoS discipline in privacy/value-patterns.ts.
 */
export const OBSERVABILITY_SCRUB_OPTIONS: ScrubOptions = {
  extraPatterns: [
    // Targeting Keys are opaque per App; this catches the repo's test canary shape.
    /tk-[a-z0-9-]{1,256}/gi,
    /spl_[a-z0-9_-]{16,256}/gi,
    // Any `sk_`/`pk_` credential, not only the 64-hex splitch shape: a WorkOS
    // `sk_test_...` is just as fatal in a log line as our own.
    /\b[sp]k_[A-Za-z0-9_-]{8,256}/g,
    // Base64url-encoded JSON (`eyJ` decodes to `{"`), with or without the dotted
    // JWT tail: control-plane access tokens and Tinybird `p.eyJ...` tokens both
    // start here.
    /eyJ[A-Za-z0-9_-]{8,4096}(?:\.[A-Za-z0-9_.-]{1,4096})?/g,
    // A bearer credential written inline, e.g. an echoed request header.
    /\bBearer\s{1,8}[A-Za-z0-9._~+/-]{8,4096}={0,2}/gi,
    // `ACCESS_TOKEN_SECRET=value`: an env-shaped assignment is the most common
    // way a secret reaches a message by accident.
    /\b[A-Z][A-Z0-9_]{0,64}(?:SECRET|TOKEN|KEY|PASSWORD)\s{0,8}=\s{0,8}\S{1,4096}/g,
    // URL userinfo (`//user:password@host`, `//dsn-key@host`). Userinfo in a URL
    // is always a credential, so matching the whole span is safe. Without this a
    // connection string is redacted only when its host happens to look like an
    // email domain, which is luck rather than policy.
    /\/\/[^\s/@]{1,512}@/g,
  ],
};
