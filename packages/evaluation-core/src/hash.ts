const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const MIX_1 = 0x7feb352d;
const MIX_2 = 0x846ca68b;
const UINT32_SPACE = 0x100000000;

function mix32(value: number): number {
  let hash = value;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, MIX_1) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, MIX_2) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

export function hashToUnitInterval(input: string): number {
  const bytes = new TextEncoder().encode(input);
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return mix32(hash) / UINT32_SPACE;
}
