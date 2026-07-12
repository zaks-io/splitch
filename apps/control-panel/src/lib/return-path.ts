export function safeReturnPath(value: string | null, requestUrl: string): string {
  if (!value) {
    return "/";
  }

  const origin = new URL(requestUrl).origin;
  try {
    if (value.startsWith("/")) {
      // Reject protocol-relative (`//host`) AND backslash variants (`/\host`,
      // `/\/host`): browsers normalize `\` to `/` for special schemes, so
      // `Location: /\evil.com` resolves to `https://evil.com/` — an open
      // redirect. A legitimate in-app path never contains a backslash.
      if (value.startsWith("//") || value.includes("\\")) {
        return "/";
      }
      return isAuthPath(value) ? "/" : value;
    }

    const url = new URL(value);
    if (url.origin !== origin) {
      return "/";
    }
    const path = `${url.pathname}${url.search}${url.hash}`;
    return isAuthPath(path) ? "/" : path;
  } catch {
    return "/";
  }
}

function isAuthPath(path: string): boolean {
  return path === "/auth/login" || path === "/auth/callback" || path === "/auth/logout";
}
