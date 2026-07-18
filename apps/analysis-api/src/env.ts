export interface AnalysisApiEnv {
  AUTH_API_ORIGIN?: string;
  AUTH_JWKS_URI?: string;
  CONTROL_PLANE_ORIGIN?: string;
  SESSION_STORE?: KVNamespace;
  SPLITCH_DEPLOYED_COMMIT_SHA?: string;
  SPLITCH_PLATFORM_TARGET?: string;
  TINYBIRD_API_URL?: string;
  TINYBIRD_COPY_TOKEN?: string;
  TINYBIRD_READ_TOKEN?: string;
  SENTRY_DSN?: string;
}
