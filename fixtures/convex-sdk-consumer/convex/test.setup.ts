/// <reference types="vite/client" />

/** Convex modules for convex-test (exclude *.test.ts). */
export const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
