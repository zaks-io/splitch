import { SplitchCliError } from "./errors.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseExpiry(value: string, nowMs: number): string | null {
  if (value === "never") return null;
  const days = /^(\d{1,5})d$/.exec(value);
  if (days) return new Date(nowMs + Number(days[1]) * DAY_MS).toISOString();
  const parsed = Date.parse(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }
  throw new SplitchCliError({
    code: "CLI_USAGE_INVALID",
    causeSummary: `--expires-at ${value} is not a date, a day count, or never`,
    remediation: "Pass never, a day count like 90d, or an ISO 8601 date such as 2027-01-01",
  });
}
