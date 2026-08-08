/**
 * Prefixes of server-minted resource ids.
 *
 * There is no single shared minted-id vocabulary module in this repo today:
 * mint sites live as string templates in control-plane / auth handlers (e.g.
 * `apr_`/`rev_` in `apps/control-plane-api/src/approval-canonical.ts`,
 * `flag_`/`var_`/`exp_`/`run_`/`org_`/`app_`/`env_`/`metric_`/`segment_`/
 * `rule_`/`salt_`/`ak_`/`ck_` across control-plane handlers,
 * `idp_`/`cver_`/`ccons_`/`user_` in auth-api). Keep this list in sync with
 * those mint sites. Credential material prefixes (`sk_`, `pk_`, `spl_`) are
 * intentionally absent — observability `extraPatterns` redact those.
 */
export const MINTED_ID_PREFIXES = [
  "apr",
  "rev",
  "org",
  "app",
  "env",
  "flag",
  "var",
  "exp",
  "run",
  "metric",
  "segment",
  "rule",
  "salt",
  "ak",
  "ck",
  "idp",
  "user",
  "prv",
  "cver",
  "ccons",
] as const;
