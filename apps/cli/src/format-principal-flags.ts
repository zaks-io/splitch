interface PrincipalFlagItem {
  readonly org: { readonly slug: string };
  readonly app: { readonly id: string; readonly key: string };
  readonly [field: string]: unknown;
}

/** Group a principal-wide Flag envelope without dropping any Flag fields. */
export function formatPrincipalFlags(payload: unknown): string | null {
  if (!isObject(payload) || !Array.isArray(payload.items)) return null;
  const groups = new Map<
    string,
    { app: string; id: string; flags: Array<Record<string, unknown>> }
  >();
  for (const candidate of payload.items) {
    if (!isPrincipalFlagItem(candidate)) return null;
    const selector = `${candidate.org.slug}/${candidate.app.key}`;
    const group = groups.get(candidate.app.id) ?? {
      app: selector,
      id: candidate.app.id,
      flags: [],
    };
    const { org: _org, app: _app, ...flag } = candidate;
    group.flags.push(flag);
    groups.set(candidate.app.id, group);
  }
  return JSON.stringify(
    {
      apps: [...groups.values()],
      readTruncated: payload.readTruncated,
      readLimit: payload.readLimit,
      cursor: payload.cursor,
    },
    null,
    2,
  );
}

function isPrincipalFlagItem(value: unknown): value is PrincipalFlagItem {
  return (
    isObject(value) &&
    isObject(value.org) &&
    typeof value.org.slug === "string" &&
    isObject(value.app) &&
    typeof value.app.id === "string" &&
    typeof value.app.key === "string"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
