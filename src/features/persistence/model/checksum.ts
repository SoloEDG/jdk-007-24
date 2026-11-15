/**
 * FNV-1a over UTF-16 code units. Cheap, synchronous and deterministic, which
 * is all we need to detect truncated / half-written draft slots.
 */
export function checksum(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
