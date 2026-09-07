/** Cloudflare overwrites this header at the edge. Missing values share one fail-closed bucket. */
export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}
