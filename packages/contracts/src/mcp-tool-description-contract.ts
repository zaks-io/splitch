import type { z } from "zod";
import { MCP_TOOL_EXAMPLE_PREFIX } from "./mcp-tool-description-example";
import { mcpToolFormatNotes } from "./mcp-tool-description-formats";
import { glossaryDefinition, glossaryTermsUsedIn } from "./mcp-tool-glossary-terms";

export interface McpToolDescriptionContractInput {
  readonly name: string;
  readonly description: string;
  readonly mutates: boolean;
  readonly inputSchema: z.ZodTypeAny;
}

/** Fail loud when a derived tool description is missing formats, terms, or a mutation example. */
export function assertMcpToolDescriptionContract(tool: McpToolDescriptionContractInput): void {
  const problems = mcpToolDescriptionProblems(tool);
  if (problems.length === 0) return;
  throw new Error(`mcp-tool-description: ${tool.name}: ${problems.join("; ")}`);
}

function mcpToolDescriptionProblems(tool: McpToolDescriptionContractInput): string[] {
  return [
    ...formatSectionProblems(tool),
    ...glossarySectionProblems(tool),
    ...(tool.mutates ? mutationExampleProblems(tool) : []),
  ];
}

function formatSectionProblems(tool: McpToolDescriptionContractInput): string[] {
  if (!tool.description.includes("\n\nFormats:")) return ["missing Formats section"];
  const problems: string[] = [];
  for (const note of mcpToolFormatNotes(tool.inputSchema)) {
    if (!tool.description.includes(`${note.name}:`)) {
      problems.push(`Formats omitted field "${note.name}"`);
    }
    if (note.text.includes("ISO-8601") && !tool.description.includes("ISO-8601")) {
      problems.push(`Formats omitted ISO-8601 for "${note.name}"`);
    }
    problems.push(...enumValueProblems(tool.description, note));
  }
  return problems;
}

function enumValueProblems(
  description: string,
  note: { readonly name: string; readonly text: string },
): string[] {
  const problems: string[] = [];
  for (const value of enumValuesIn(note.text)) {
    if (!description.includes(JSON.stringify(value))) {
      problems.push(`Formats omitted enum value ${JSON.stringify(value)} for "${note.name}"`);
    }
  }
  return problems;
}

function glossarySectionProblems(tool: McpToolDescriptionContractInput): string[] {
  const scanned = descriptionWithoutTermsAndExample(tool.description);
  const problems: string[] = [];
  for (const term of glossaryTermsUsedIn(scanned)) {
    if (!tool.description.includes(glossaryDefinition(term))) {
      problems.push(`undefined glossary term "${term}"`);
    }
  }
  return problems;
}

function mutationExampleProblems(tool: McpToolDescriptionContractInput): string[] {
  const marker = `\n\n${MCP_TOOL_EXAMPLE_PREFIX} `;
  const index = tool.description.lastIndexOf(marker);
  if (index === -1) return ["mutating route missing Example arguments"];
  const raw = tool.description.slice(index + marker.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [`Example arguments is not JSON: ${raw}`];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return ["Example arguments must be a JSON object"];
  }
  const result = tool.inputSchema.safeParse(parsed);
  if (result.success) return [];
  const issue = result.error.issues[0];
  return [
    `Example arguments failed input schema` +
      (issue ? ` at ${issue.path.join(".") || "(root)"}: ${issue.message}` : ""),
  ];
}

function descriptionWithoutTermsAndExample(description: string): string {
  const termsAt = description.indexOf("\n\nTerms:");
  const exampleAt = description.indexOf(`\n\n${MCP_TOOL_EXAMPLE_PREFIX} `);
  const cut = [termsAt, exampleAt].filter((index) => index >= 0);
  if (cut.length === 0) return description;
  return description.slice(0, Math.min(...cut));
}

function enumValuesIn(text: string): unknown[] {
  const match = text.match(/one of (.+)\.$/);
  if (!match?.[1]) return [];
  try {
    return JSON.parse(`[${match[1]}]`) as unknown[];
  } catch {
    return [];
  }
}
