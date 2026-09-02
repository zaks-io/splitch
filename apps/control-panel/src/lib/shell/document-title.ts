const PRODUCT_NAME = "splitch";

export function documentTitle(...parts: [string, ...string[]]): string {
  for (const part of parts) {
    if (part.trim().length === 0) {
      throw new Error("Document title parts must not be empty");
    }
  }

  return [...parts, PRODUCT_NAME].join(" · ");
}
