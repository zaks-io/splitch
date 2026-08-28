import {
  PERSISTED_JSON_INCOMING_DEPTH_MESSAGE,
  PERSISTED_JSON_MAX_INCOMING_DEPTH,
} from "./persisted-field-limits";

type IncomingJsonFrame = { node: unknown; path: string[]; depth: number };

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

/**
 * Walk every key of a JSON value iteratively. Returns the first node deeper
 * than {@link PERSISTED_JSON_MAX_INCOMING_DEPTH}, independent of discriminator
 * validity or which keys a later union accepts.
 */
export function incomingJsonBoundIssue(
  value: unknown,
  rootPath: readonly string[] = [],
): IncomingJsonBoundIssue | null {
  const queue: IncomingJsonFrame[] = [{ node: value, path: [...rootPath], depth: 1 }];
  while (queue.length > 0) {
    const frame = queue.shift();
    if (frame === undefined) break;
    if (frame.depth > PERSISTED_JSON_MAX_INCOMING_DEPTH) {
      return { path: frame.path, message: PERSISTED_JSON_INCOMING_DEPTH_MESSAGE };
    }
    enqueueJsonChildren(queue, frame);
  }
  return null;
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

function enqueueJsonChildren(queue: IncomingJsonFrame[], frame: IncomingJsonFrame): void {
  if (frame.node === null || typeof frame.node !== "object") {
    return;
  }
  if (Array.isArray(frame.node)) {
    for (const [index, child] of frame.node.entries()) {
      queue.push({ node: child, path: [...frame.path, String(index)], depth: frame.depth + 1 });
    }
    return;
  }
  for (const [key, child] of Object.entries(frame.node)) {
    queue.push({ node: child, path: [...frame.path, key], depth: frame.depth + 1 });
  }
}

function jsonChildren(node: unknown): unknown[] {
  if (node === null || typeof node !== "object") {
    return [];
  }
  return Array.isArray(node) ? node : Object.values(node);
}
