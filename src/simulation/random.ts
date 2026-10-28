/** Seeded PRNG (mulberry32): the same seed always yields the same sequence in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export const pick = <T>(items: readonly T[], random: () => number): T => {
  if (items.length === 0) throw new Error("pick() needs at least one item");
  return items[Math.floor(random() * items.length)]!;
};
