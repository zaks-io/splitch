export function redactPersonalAccessTokenSecrets(value: string): string {
  return value.replace(/spl_pat_[0-9a-f]{64}/gi, "[REDACTED]");
}
