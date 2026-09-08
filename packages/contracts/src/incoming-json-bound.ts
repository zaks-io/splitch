import {
  PERSISTED_JSON_INCOMING_DEPTH_MESSAGE,
  PERSISTED_JSON_MAX_INCOMING_DEPTH,
} from "./persisted-field-limits";

type JsonChild = { key: string; node: unknown };

type IncomingJsonFrame = {
  children: Iterator<JsonChild>;
  path: string[];
  depth: number;
};

export function persistedJsonDepth(value: unknown): number {
  let maxDepth = 1;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 1 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    maxDepth = Math.max(maxDepth, frame.depth);
    pushJsonChildren(stack, frame.node, frame.depth);
  }
  return maxDepth;
}

export type IncomingJsonBoundIssue = { path: string[]; message: string };

type IncomingJsonBoundWalk = {
  issue: IncomingJsonBoundIssue | null;
  visited: number;
};

/**
 * Walk every key of a JSON value iteratively. Returns the first node deeper
 * than {@link PERSISTED_JSON_MAX_INCOMING_DEPTH}, independent of discriminator
 * validity or which keys a later union accepts.
 */
export function incomingJsonBoundIssue(
  value: unknown,
  rootPath: readonly string[] = [],
): IncomingJsonBoundIssue | null {
  return walkIncomingJsonBound(value, rootPath).issue;
}

/** Nodes visited by {@link incomingJsonBoundIssue}, including the root. */
export function incomingJsonBoundVisited(value: unknown, rootPath: readonly string[] = []): number {
  return walkIncomingJsonBound(value, rootPath).visited;
}

function walkIncomingJsonBound(value: unknown, rootPath: readonly string[]): IncomingJsonBoundWalk {
  let visited = 1;
  const stack: IncomingJsonFrame[] = [
    { children: jsonChildIterator(value), path: [...rootPath], depth: 1 },
  ];
  while (stack.length > 0) {
    const parent = stack.at(-1);
    if (parent === undefined) break;
    const next = parent.children.next();
    if (next.done) {
      stack.pop();
      continue;
    }

    visited += 1;
    const depth = parent.depth + 1;
    const path = [...parent.path, next.value.key];
    if (depth > PERSISTED_JSON_MAX_INCOMING_DEPTH) {
      return {
        issue: { path, message: PERSISTED_JSON_INCOMING_DEPTH_MESSAGE },
        visited,
      };
    }
    if (hasJsonChildren(next.value.node)) {
      stack.push({ children: jsonChildIterator(next.value.node), path, depth });
    }
  }
  return { issue: null, visited };
}

function pushJsonChildren(
  stack: Array<{ node: unknown; depth: number }>,
  node: unknown,
  depth: number,
): void {
  for (const child of jsonChildren(node)) {
    stack.push({ node: child, depth: depth + 1 });
  }
}

function hasJsonChildren(node: unknown): node is object {
  return node !== null && typeof node === "object";
}

function* jsonChildIterator(node: unknown): Generator<JsonChild> {
  if (!hasJsonChildren(node)) return;
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      yield { key: String(index), node: node[index] };
    }
    return;
  }
  for (const key in node) {
    if (Object.hasOwn(node, key)) {
      yield { key, node: (node as Record<string, unknown>)[key] };
    }
  }
}

function jsonChildren(node: unknown): unknown[] {
  if (node === null || typeof node !== "object") {
    return [];
  }
  return Array.isArray(node) ? node : Object.values(node);
}
