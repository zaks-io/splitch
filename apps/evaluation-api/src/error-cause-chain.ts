export function errorCauseChain(cause: unknown): string[] {
  const chain: string[] = [];
  const seen = new Set<Error>();
  let current = cause;

  while (current instanceof Error) {
    if (seen.has(current)) {
      chain.push("[circular Error cause]");
      return chain;
    }
    seen.add(current);
    chain.push(current.message);
    current = current.cause;
  }

  if (current !== undefined) chain.push(String(current));
  return chain;
}
