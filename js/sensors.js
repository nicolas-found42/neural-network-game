// Sensors: toroidal ray-casting + threat radar.
// Extracted from game.js World for locality: all 21 inputs computed here
// behind one interface. Internal seam exposed for direct unit testing,
// external seam stays as World.step's sensor phase.
import { CONFIG } from './config.js';

const W = CONFIG.arena.width;
const H = CONFIG.arena.height;
const SENS = CONFIG.sensors;
const AST = CONFIG.asteroid;
const BULLET = CONFIG.bullet;
const DEG = Math.PI / 180;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const tdx = (ax, sx) => { let d = ax - sx; if (d > W / 2) d -= W; else if (d < -W / 2) d += W; return d; };
export const tdy = (ay, sy) => { let d = ay - sy; if (d > H / 2) d -= H; else if (d < -H / 2) d += H; return d; };

// Pure sensing: returns the 21-element input array for the Network.
// Mutates agent.inputs for the vision-ray overlay (caller-visible side effect).
export function sense(agent, asteroids) {
  const inputs = new Array(CONFIG.nn.inputs).fill(0);
  inputs[11] = 1; // bias
  inputs[9] = clamp(agent.vx / SENS.velScale, -1, 1);
  inputs[10] = clamp(agent.vy / SENS.velScale, -1, 1);
  // Rays: nearest intersection, toroidal arena (rocks across a seam are visible).
  for (let k = 0; k < SENS.rayOffsetsDeg.length; k++) {
    const ang = agent.heading + SENS.rayOffsetsDeg[k] * DEG;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    let nearest = Infinity;
    for (const a of asteroids) {
      const ox = tdx(a.x, agent.x);
      const oy = tdy(a.y, agent.y);
      const t = ox * dx + oy * dy;
      if (t < 0) continue;
      const perp2 = ox * ox + oy * oy - t * t;
      const r2 = a.r * a.r;
      if (perp2 > r2) continue;
      const d = Math.max(0, t - Math.sqrt(r2 - perp2));
      if (d < nearest) nearest = d;
    }
    inputs[k] = nearest === Infinity ? 0 : clamp(1 - nearest / SENS.range, 0, 1);
  }
  // Nearest-threat radar: one toroidal pass over asteroids.
  let nd2 = Infinity, n2d2 = Infinity, nx = 0, ny = 0, nvx = 0, nvy = 0, nr = 1, pressure = 0;
  for (const a of asteroids) {
    const dx = tdx(a.x, agent.x);
    const dy = tdy(a.y, agent.y);
    const d2 = dx * dx + dy * dy;
    if (d2 < nd2) {
      n2d2 = nd2; // old nearest becomes second-nearest
      nd2 = d2; nx = dx; ny = dy; nvx = a.vx; nvy = a.vy; nr = a.r;
    } else if (d2 < n2d2) {
      n2d2 = d2;
    }
    pressure += 1 - Math.min(Math.sqrt(d2), SENS.range) / SENS.range;
  }
  if (nd2 < Infinity) {
    const d = Math.sqrt(nd2);
    let bearing = Math.atan2(ny, nx) - agent.heading;
    bearing = Math.atan2(Math.sin(bearing), Math.cos(bearing)); // wrap to [-pi, pi]
    inputs[12] = bearing / Math.PI; // threat bearing, +1 = hard right
    inputs[13] = clamp(1 - d / SENS.range, 0, 1); // threat closeness
    const closing = (nx * (nvx - agent.vx) + ny * (nvy - agent.vy)) / d; // d(dist)/dt, <0 = approaching
    inputs[14] = clamp(closing / SENS.velScale, -1, 1);
    // Lateral (tangential) relative velocity: which way the threat is crossing our nose.
    const lateral = (-ny * (nvx - agent.vx) + nx * (nvy - agent.vy)) / d;
    inputs[16] = clamp(lateral / SENS.velScale, -1, 1);
    inputs[18] = clamp(nr / AST.sizes.L.r, 0, 1); // threat size: 1 = large, ~0.29 = small
  }
  if (n2d2 < Infinity) {
    inputs[17] = clamp(1 - Math.sqrt(n2d2) / SENS.range, 0, 1); // second-nearest closeness
  }
  inputs[19] = clamp(pressure / SENS.pressureNorm, 0, 1); // proximity-weighted encirclement
  inputs[15] = agent.bulletsOut / BULLET.maxAlivePerShip; // guns state
  inputs[20] = agent.memory; // learned state fed back from last step's output 25
  agent.inputs = inputs; // kept for the vision-ray overlay
  return inputs;
}
