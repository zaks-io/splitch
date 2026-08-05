/**
 * Documentation bodies are authored once as blocks and rendered twice: as a page
 * for people and as `.md` for agents. Anything expressible only in one renderer
 * would drift between the two, so the block set stays deliberately small.
 */
export type DocBlock =
  | { readonly kind: "prose"; readonly text: string }
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "code"; readonly lang: string; readonly code: string }
  | { readonly kind: "list"; readonly items: readonly string[] }
  | {
      readonly kind: "table";
      readonly head: readonly string[];
      readonly rows: readonly (readonly string[])[];
    };

/** Inline markdown the prose renderer understands: `code` and [text](url). */
export type InlineSpan =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string };

const INLINE_PATTERN = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;

export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let cursor = 0;
  INLINE_PATTERN.lastIndex = 0;
  let match = INLINE_PATTERN.exec(text);
  while (match) {
    if (match.index > cursor) {
      spans.push({ kind: "text", text: text.slice(cursor, match.index) });
    }
    if (match[1] !== undefined) {
      spans.push({ kind: "code", text: match[1] });
    } else if (match[2] !== undefined && match[3] !== undefined) {
      spans.push({ kind: "link", text: match[2], href: match[3] });
    }
    cursor = match.index + match[0].length;
    match = INLINE_PATTERN.exec(text);
  }
  if (cursor < text.length) {
    spans.push({ kind: "text", text: text.slice(cursor) });
  }
  return spans;
}

function renderRow(cells: readonly string[]): string {
  // An unescaped `|` in a cell opens a new markdown column, so the `.md` table
  // would gain a column the rendered page does not have.
  return `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`;
}

function blockToMarkdown(block: DocBlock): string {
  if (block.kind === "prose") return block.text;
  if (block.kind === "heading") return `## ${block.text}`;
  if (block.kind === "code") return `\`\`\`${block.lang}\n${block.code}\n\`\`\``;
  if (block.kind === "list") return block.items.map((item) => `- ${item}`).join("\n");
  return [
    renderRow(block.head),
    renderRow(block.head.map(() => "---")),
    ...block.rows.map(renderRow),
  ].join("\n");
}

export function blocksToMarkdown(blocks: readonly DocBlock[]): string {
  return blocks.map(blockToMarkdown).join("\n\n");
}

/** Stable across reorders, unlike an array index: keyed on what the block says. */
export function blockKey(block: DocBlock): string {
  if (block.kind === "prose" || block.kind === "heading") return `${block.kind}:${block.text}`;
  if (block.kind === "code") return `code:${block.code}`;
  if (block.kind === "list") return `list:${block.items.join("|")}`;
  return `table:${block.head.join("|")}`;
}
