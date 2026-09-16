import {
  HydratedPrincipalFlagListResponseSchema,
  PrincipalFlagListResponseSchema,
} from "@splitch/sdk/control-plane";
import {
  EMPTY_FLAG_CATALOG,
  flagReadContractError,
  formatFlagSummaryList,
  formatHydratedFlag,
  withFlagListBound,
} from "./format-flag-read.js";
import { terminalText } from "./format-payload.js";

interface PrincipalFlagScope {
  readonly org: { readonly slug: string };
  readonly app: { readonly id: string; readonly key: string };
}

interface PrincipalFlagGroup<T extends PrincipalFlagScope> {
  readonly selector: string;
  readonly id: string;
  readonly flags: T[];
}

/** Group a principal-wide Flag envelope with the App-scoped Flag-read renderer. */
export function formatPrincipalFlags(payload: unknown, summary: boolean): string {
  return summary ? formatPrincipalSummary(payload) : formatPrincipalHydrated(payload);
}

function formatPrincipalHydrated(payload: unknown): string {
  const parsed = HydratedPrincipalFlagListResponseSchema.safeParse(payload);
  if (!parsed.success) throw flagReadContractError("principal_flags_list", "hydrated");
  if (parsed.data.items.length === 0) return withFlagListBound(EMPTY_FLAG_CATALOG, parsed.data);
  return withFlagListBound(
    groupPrincipalFlags(parsed.data.items)
      .map((group) => formatAppGroup(group, group.flags.map(formatHydratedFlag).join("\n\n")))
      .join("\n\n"),
    parsed.data,
  );
}

function formatPrincipalSummary(payload: unknown): string {
  const parsed = PrincipalFlagListResponseSchema.safeParse(payload);
  if (!parsed.success) throw flagReadContractError("principal_flags_list", "summary");
  if (parsed.data.items.length === 0) return withFlagListBound(EMPTY_FLAG_CATALOG, parsed.data);
  return withFlagListBound(
    groupPrincipalFlags(parsed.data.items)
      .map((group) => formatAppGroup(group, formatFlagSummaryList(group.flags)))
      .join("\n\n"),
    parsed.data,
  );
}

function groupPrincipalFlags<T extends PrincipalFlagScope>(
  items: readonly T[],
): Array<PrincipalFlagGroup<T>> {
  const groups = new Map<string, PrincipalFlagGroup<T>>();
  for (const item of items) {
    const group = groups.get(item.app.id) ?? {
      selector: `${item.org.slug}/${item.app.key}`,
      id: item.app.id,
      flags: [] as T[],
    };
    group.flags.push(item);
    groups.set(item.app.id, group);
  }
  return [...groups.values()];
}

function formatAppGroup<T extends PrincipalFlagScope>(
  group: PrincipalFlagGroup<T>,
  body: string,
): string {
  return `App: ${terminalText(group.selector)} (${terminalText(group.id)})\n${body}`;
}
