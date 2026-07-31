import { z } from "zod";

/** SHA-256 digest of UTF-8 RFC 8785 JSON Canonicalization Scheme bytes. */
export const CanonicalJsonSha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export type CanonicalJsonSha256 = z.infer<typeof CanonicalJsonSha256Schema>;
