// Single global seeded random stream (Mulberry32).
//
// INVARIANT: every simulation/evolution random draw must go through this stream
// (rng/rand/randn/randInt) — that is what makes a seeded run reproducible.
// Rendering must NEVER consume it: visual-only randomness (e.g. the starfield
// in render.js) stays on Math.random deliberately.
let s = 1;
export function setSeed(seed) { s = seed >>> 0; if (s === 0) s = 0x9E3779B9; }
export function rng() { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
export const rand = (a, b) => a + rng() * (b - a);
export const randn = () => { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
export const randInt = (n) => Math.floor(rng() * n);
