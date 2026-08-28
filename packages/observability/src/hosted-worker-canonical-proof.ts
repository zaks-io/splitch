import { isSourceFile, type Node, type SourceFile } from "typescript";
import { locationOf } from "./hosted-worker-wrap-ast.js";

export type CanonicalProof =
  | { readonly wrapped: true }
  | { readonly wrapped: false; readonly reason: string; readonly location: string };

export function canonicalFailure(file: SourceFile, node: Node, reason: string): CanonicalProof {
  return { wrapped: false, reason, location: locationOf(file, isSourceFile(node) ? file : node) };
}
