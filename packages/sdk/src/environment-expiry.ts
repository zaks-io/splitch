import type { Logger } from "./evaluate";

export const ENVIRONMENT_EXPIRED_REMEDIATION =
  "Create a new Temporary Environment and configure its credential";

/** One client owns one expiry diagnostic even when several accessors fail. */
export function environmentExpiryLogger(logger: Logger): Logger {
  let logged = false;
  return {
    error(message, detail) {
      const code =
        typeof detail === "object" && detail !== null
          ? ((detail as { errorCode?: unknown; code?: unknown }).errorCode ??
            (detail as { code?: unknown }).code)
          : undefined;
      if (code === "ENVIRONMENT_EXPIRED") {
        if (logged) return;
        logged = true;
      }
      logger.error(message, detail);
    },
    debug(message, detail) {
      logger.debug(message, detail);
    },
  };
}
