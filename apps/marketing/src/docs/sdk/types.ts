import type { DocBlock } from "../blocks";

export interface SdkTopic {
  /** URL segment: `/docs/sdk/{slug}`. */
  readonly slug: string;
  readonly title: string;
  /** One line, used on the index, in `<meta name="description">`, and in llms.txt. */
  readonly summary: string;
  /**
   * `guide` topics explain one capability of the SDK contract. `integration`
   * topics take one runtime from `npm install` to a first resolving Flag. The
   * split is what lets the index and llms.txt answer "how do I wire this up in
   * X" without making a reader scan eleven capability pages for the answer.
   */
  readonly section: "guide" | "integration";
  readonly blocks: readonly DocBlock[];
}
