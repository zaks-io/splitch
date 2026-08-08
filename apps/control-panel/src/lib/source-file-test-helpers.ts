import {
  createSourceFile,
  forEachChild,
  type Node,
  ScriptKind,
  ScriptTarget,
  type SourceFile,
} from "typescript";

export function parseSourceFile(source: string, fileName: string): SourceFile {
  const scriptKind = fileName.endsWith(".tsx") ? ScriptKind.TSX : ScriptKind.TS;
  return createSourceFile(fileName, source, ScriptTarget.Latest, true, scriptKind);
}

export function visitNodes(node: Node, visitor: (node: Node) => void): void {
  visitor(node);
  forEachChild(node, (child) => visitNodes(child, visitor));
}
