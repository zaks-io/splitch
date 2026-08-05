import { describe, expect, it } from "vitest";
import { blocksToMarkdown } from "./blocks";

describe("blocksToMarkdown", () => {
  it("keeps a pipe inside its own table cell", () => {
    // An unescaped `|` opens a new markdown column, so the `.md` table would
    // carry a column the rendered page does not have.
    const markdown = blocksToMarkdown([
      { kind: "table", head: ["Option", "Default"], rows: [["`mode`", "`live | shadow`"]] },
    ]);

    expect(markdown).toBe(
      ["| Option | Default |", "| --- | --- |", "| `mode` | `live \\| shadow` |"].join("\n"),
    );
  });
});
