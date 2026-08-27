import { browserTopic } from "./browser";
import { cloudflareTopic } from "./cloudflare";
import { convexTopic } from "./convex";
import { evaluateAllTopic } from "./evaluate-all";
import { nodeTopic } from "./node";
import { reactTopic } from "./react";
import { dedupTopic, failuresTopic, idempotencyTopic, methodsTopic } from "./semantics";
import { sentryTopic } from "./sentry";
import { credentialsTopic, installTopic, optionsTopic } from "./setup";
import type { SdkTopic } from "./types";

export type { SdkTopic } from "./types";

/** One runtime each, from `npm install` to a first resolving Flag. */
export const sdkIntegrationTopics: readonly SdkTopic[] = [
  nodeTopic,
  browserTopic,
  reactTopic,
  convexTopic,
  cloudflareTopic,
  sentryTopic,
];

/** The contract every integration shares, in reading order. */
export const sdkGuideTopics: readonly SdkTopic[] = [
  installTopic,
  credentialsTopic,
  methodsTopic,
  evaluateAllTopic,
  idempotencyTopic,
  failuresTopic,
  dedupTopic,
  optionsTopic,
];

/** Every topic, which is also the order the index and llms.txt list them in. */
export const sdkTopics: readonly SdkTopic[] = [...sdkGuideTopics, ...sdkIntegrationTopics];

const bySlug = new Map(sdkTopics.map((topic) => [topic.slug, topic]));

export function findSdkTopic(slug: string): SdkTopic | undefined {
  return bySlug.get(slug);
}
