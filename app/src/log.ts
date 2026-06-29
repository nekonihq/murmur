// Tiny timestamped logger so app events line up with the daemon log. Every line
// is prefixed `[murmur HH:MM:SS.mmm] <tag>` for easy grepping in Metro.

export function log(tag: string, ...args: unknown[]): void {
  const t = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  console.log(`[murmur ${t}] ${tag}`, ...args);
}
