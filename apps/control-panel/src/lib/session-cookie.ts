const TOKEN_PREFIX = "spl_";
const TOKEN_HEX_LENGTH = 64;
const SESSION_TOKEN_PATTERN = /^spl_[0-9a-f]{64}$/;

export function generateOpaqueToken(): string {
  return `${TOKEN_PREFIX}${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

export function isOpaqueToken(token: string): boolean {
  return (
    token.length === TOKEN_PREFIX.length + TOKEN_HEX_LENGTH && SESSION_TOKEN_PATTERN.test(token)
  );
}

export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(digest));
}

export function serializeHttpOnlyCookie(
  name: string,
  value: string,
  options: { maxAge: number },
): string {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${options.maxAge}`;
}

export function clearHttpOnlyCookie(name: string): string {
  return serializeHttpOnlyCookie(name, "", { maxAge: 0 });
}

export function parseCookie(cookieHeader: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!cookieHeader) {
    return cookies;
  }

  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name || valueParts.length === 0) {
      continue;
    }
    try {
      cookies.set(name, decodeURIComponent(valueParts.join("=")));
    } catch {
      cookies.set(name, "");
    }
  }
  return cookies;
}

export function nowSeconds(now: number): number {
  return Math.floor(now / 1000);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
