import type { DocBlock } from "../blocks";

export interface SdkTopic {
  /** URL segment: `/docs/sdk/{slug}`. */
  readonly slug: string;
  readonly title: string;
  /** One line, used on the index, in `<meta name="description">`, and in llms.txt. */
  readonly summary: string;
  readonly blocks: readonly DocBlock[];
}
