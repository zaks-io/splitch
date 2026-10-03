import type { z } from "zod";
import { mcpToolArgumentsExample, renderMcpToolExample } from "./mcp-tool-description-example";
import { mcpToolFormatNotes, renderMcpToolFormats } from "./mcp-tool-description-formats";
import { glossaryDefinition, glossaryTermsUsedIn } from "./mcp-tool-glossary-terms";

/**
 * MCP/CLI share this description (ADR-0023). Formats, glossary definitions, and
 * mutation examples are derived from the same registry Zod that authorizes the
 * call — never hand-copied into generated MCP files.
 */
export function composeMcpToolDescription(input: {
  readonly narrative: string;
  readonly mutates: boolean;
  readonly inputSchema: z.ZodTypeAny;
  readonly operationId: string;
  readonly bodySchema?: z.ZodTypeAny;
}): string {
  const sections = [
    input.narrative.trim(),
    renderMcpToolFormats(mcpToolFormatNotes(input.inputSchema)),
  ];
  const terms = glossaryTermsUsedIn(sections.join("\n"));
  if (terms.length > 0) {
    sections.push(`Terms: ${terms.map(glossaryDefinition).join(" ")}`);
  }
  if (input.mutates) {
    sections.push(
      renderMcpToolExample(
        mcpToolArgumentsExample(input.inputSchema, input.operationId, input.bodySchema),
      ),
    );
  }
  return sections.join("\n\n");
}
