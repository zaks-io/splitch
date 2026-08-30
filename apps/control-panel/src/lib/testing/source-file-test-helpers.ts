import { forEachChild, type Node } from "typescript";

export function visitNodes(node: Node, visitor: (node: Node) => void): void {
  visitor(node);
  forEachChild(node, (child) => visitNodes(child, visitor));
}
