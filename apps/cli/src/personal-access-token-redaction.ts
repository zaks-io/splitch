export function redactPersonalAccessTokenSecrets(value: string): string {
  return value
    .replace(/spl_pat_[0-9a-f]{64}/gi, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{8,4096}(?:\.[A-Za-z0-9_.-]{1,4096})?/g, "[REDACTED]");
}
