import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@splitch/ui/components/table";
import { blockKey, type DocBlock, parseInline } from "../docs/blocks";
import { CodeSnippet } from "./code-snippet";

export function DocInline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((span, index) => {
        const key = `${span.kind}-${index}`;
        if (span.kind === "code") {
          return (
            <code className="font-mono text-[0.9em] text-foreground" key={key}>
              {span.text}
            </code>
          );
        }
        if (span.kind === "link") {
          return (
            <a className="text-arm-control underline underline-offset-4" href={span.href} key={key}>
              {span.text}
            </a>
          );
        }
        return <span key={key}>{span.text}</span>;
      })}
    </>
  );
}

function Block({ block }: { block: DocBlock }) {
  switch (block.kind) {
    case "prose":
      return (
        <p className="max-w-2xl text-muted-foreground leading-relaxed">
          <DocInline text={block.text} />
        </p>
      );
    case "heading":
      return (
        <h2 className="font-display font-semibold text-2xl text-foreground tracking-tight">
          {block.text}
        </h2>
      );
    case "code":
      return <CodeSnippet code={block.code} />;
    case "list":
      return (
        <ul className="grid max-w-2xl list-disc gap-2 pl-5 text-muted-foreground leading-relaxed">
          {block.items.map((item) => (
            <li key={item}>
              <DocInline text={item} />
            </li>
          ))}
        </ul>
      );
    case "table":
      return (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                {block.head.map((cell) => (
                  <TableHead key={cell}>
                    <DocInline text={cell} />
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {block.rows.map((row) => (
                <TableRow key={row.join("|")}>
                  {row.map((cell, index) => (
                    <TableCell
                      className="align-top text-muted-foreground"
                      key={`${block.head[index]}-${cell}`}
                    >
                      <DocInline text={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      );
  }
}

export function DocBody({ blocks }: { blocks: readonly DocBlock[] }) {
  return (
    <div className="grid gap-6">
      {blocks.map((block) => (
        <Block block={block} key={blockKey(block)} />
      ))}
    </div>
  );
}
