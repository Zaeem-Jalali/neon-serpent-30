/* Pure helpers shared by the engine and the presentation layers.
 * Deliberately free of any browser API so the engine can run under Node.
 */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function key(x, y) {
  return `${x}:${y}`;
}

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export { clamp, key, mulberry32, hashSeed };
