import { dedupTopic, failuresTopic, idempotencyTopic, methodsTopic } from "./semantics";
import { credentialsTopic, installTopic, optionsTopic } from "./setup";
import type { SdkTopic } from "./types";

export type { SdkTopic } from "./types";

/** Reading order, which is also the order the index and llms.txt list them in. */
export const sdkTopics: readonly SdkTopic[] = [
  installTopic,
  credentialsTopic,
  methodsTopic,
  idempotencyTopic,
  failuresTopic,
  dedupTopic,
  optionsTopic,
];

const bySlug = new Map(sdkTopics.map((topic) => [topic.slug, topic]));

export function findSdkTopic(slug: string): SdkTopic | undefined {
  return bySlug.get(slug);
}
