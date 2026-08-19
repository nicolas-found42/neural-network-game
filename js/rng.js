// Seeded random stream (Mulberry32) with explicit seam.
//
// Legacy global stream (setSeed/rng/rand/...) remains for bootstrap
// compatibility. New code should create an explicit RNG via createRNG(seed)
// and thread it through constructors — that makes determinism an interface,
// not a comment. Rendering must NEVER consume the seeded stream: visual-only
// randomness (e.g. the starfield in render.js) stays on Math.random.
let s = 1;
export function setSeed(seed) { s = seed >>> 0; if (s === 0) s = 0x9E3779B9; }
export function rng() { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
export const rand = (a, b) => a + rng() * (b - a);
export const randn = () => { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
export const randInt = (n) => Math.floor(rng() * n);

// Explicit seam: factory returning an isolated RNG with the same algorithm.
// Two adapters justify the seam: seeded stream for simulation, Math.random for
// rendering (never mixes). Thread the returned object through World/Population/
// Genome instead of importing the global.
export function createRNG(seed) {
  let local = seed >>> 0;
  if (local === 0) local = 0x9E3779B9;
  function localRng() {
    local |= 0;
    local = (local + 0x6D2B79F5) | 0;
    let t = Math.imul(local ^ (local >>> 15), 1 | local);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    rng: localRng,
    rand: (a, b) => a + localRng() * (b - a),
    randInt: (n) => Math.floor(localRng() * n),
    randn: () => {
      let u = 0, v = 0;
      while (u === 0) u = localRng();
      while (v === 0) v = localRng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    // for testing / debugging: inspect or reseed without recreating
    getState: () => local,
    setSeed: (ns) => { local = ns >>> 0; if (local === 0) local = 0x9E3779B9; },
  };
}

// Shared default instance shape for convenience where injection is not yet
// threaded (falls back to the legacy global stream via the functions above).
export const defaultRNG = { rng, rand, randn, randInt };
