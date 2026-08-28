import { isClassDeclaration, isExportAssignment, type SourceFile, SyntaxKind } from "typescript";
import { canonicalClassProof } from "./hosted-worker-canonical-class.js";
import { canonicalFailure, type CanonicalProof } from "./hosted-worker-canonical-proof.js";
import { canonicalSourceFailure } from "./hosted-worker-canonical-source.js";
import { isCanonicalWrapperCall } from "./hosted-worker-canonical-wrapper.js";

export function canonicalDefaultExportProof(file: SourceFile): CanonicalProof {
  const unsafe = canonicalSourceFailure(file);
  if (unsafe) return canonicalFailure(file, unsafe, "non-canonical dynamic or wrapper syntax");
  const defaults = file.statements.filter(
    (statement) =>
      (isExportAssignment(statement) && !statement.isExportEquals) ||
      (isClassDeclaration(statement) && isDefaultExport(statement)),
  );
  if (defaults.length !== 1) {
    return canonicalFailure(
      file,
      defaults[1] ?? file,
      "expected exactly one canonical default export",
    );
  }
  const exported = defaults[0];
  if (!exported) return canonicalFailure(file, file, "expected one canonical default export");
  if (isExportAssignment(exported)) {
    return isCanonicalWrapperCall(file, exported.expression)
      ? { wrapped: true }
      : canonicalFailure(
          file,
          exported.expression,
          "default export must be a direct official wrapper call",
        );
  }
  return isClassDeclaration(exported)
    ? canonicalClassProof(file, exported)
    : canonicalFailure(file, exported, "default export is not canonical");
}

function isDefaultExport(node: { readonly modifiers?: readonly { readonly kind: SyntaxKind }[] }) {
  return (
    node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) &&
    node.modifiers.some((modifier) => modifier.kind === SyntaxKind.DefaultKeyword)
  );
}
