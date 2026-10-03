/**
 * Curated CONTEXT.md terms that MCP tool descriptions may use. Definitions are
 * the glossary sentences only — no repo paths — so the published agent surface
 * stays free of internal references.
 */

const MCP_TOOL_GLOSSARY_TERMS = {
  Organization: "the account and ownership unit. It owns Apps and has Users as members.",
  App: "the product or service surface that groups related Flags and hosts Experiments.",
  Environment: "a named deployment context under an App, such as `dev` or `prod`.",
  Flag: "a named feature toggle with a key, Variants, Targeting Rules, and enabled state.",
  Variant: "the OpenFeature term for a possible Flag value.",
  "Targeting Key": "the stable identifier splitch buckets on and measures against.",
  "Evaluation Context":
    "the object carrying the Targeting Key and attributes used at evaluation time.",
  Experiment:
    "a test that compares Variants of one or more Flags to measure their effect on Metrics for a population of Entities.",
  Entity: "the randomization unit under experiment, identified by the Targeting Key.",
  Assignment: "the pure deterministic result of assign(Experiment Run, Targeting Key).",
  "Experiment Run": "the immutable, time-boxed unit of experiment analysis.",
  Conclusion:
    "the immutable decision evidence recorded when Conclude Ends a Run and selects its winning Variant.",
  Exposure: "the event that an Entity actually encountered its assigned Variant.",
  Metric: "a fact plus an aggregation.",
  Promotion: "applying a Flag Configuration, or a Variant's availability, to a target Environment.",
  "Client Key": "the public, non-secret key used by untrusted client-side SDKs.",
  "API Key": "the secret server-side SDK key.",
} as const;

type McpToolGlossaryTerm = keyof typeof MCP_TOOL_GLOSSARY_TERMS;

const TERM_ALIASES: Readonly<Record<string, McpToolGlossaryTerm>> = {
  Run: "Experiment Run",
  Runs: "Experiment Run",
  Organizations: "Organization",
  Apps: "App",
  Environments: "Environment",
  Flags: "Flag",
  Variants: "Variant",
  Experiments: "Experiment",
  Entities: "Entity",
  Assignments: "Assignment",
  Conclusions: "Conclusion",
  Exposures: "Exposure",
  Metrics: "Metric",
  Promotions: "Promotion",
  "Client Keys": "Client Key",
  "API Keys": "API Key",
  "Targeting Keys": "Targeting Key",
};

const MATCH_TERMS = [...Object.keys(MCP_TOOL_GLOSSARY_TERMS), ...Object.keys(TERM_ALIASES)].sort(
  (left, right) => right.length - left.length,
);

export function glossaryDefinition(term: McpToolGlossaryTerm): string {
  return `${term} — ${MCP_TOOL_GLOSSARY_TERMS[term]}`;
}

/** Terms from the curated list that appear as words in `text`. */
export function glossaryTermsUsedIn(text: string): McpToolGlossaryTerm[] {
  const used = new Set<McpToolGlossaryTerm>();
  for (const candidate of MATCH_TERMS) {
    if (!termAppears(text, candidate)) continue;
    const canonical = TERM_ALIASES[candidate] ?? (candidate as McpToolGlossaryTerm);
    used.add(canonical);
  }
  return [...used];
}

function termAppears(text: string, term: string): boolean {
  const pattern = new RegExp(`(?<!\\w)${escapeRegExp(term)}(?!\\w)`);
  return pattern.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
