// Physics: toroidal wrapping, asteroid shapes/splits, speed caps, elastic collisions.
// Extracted from game.js World for locality: all asteroid/ship motion math lives here.
// Interface is small (wrap, createAsteroid, capAsteroidSpeed, collideAsteroids)
// over ~60 LOC of implementation. Internal seam exposed for unit tests.
import { CONFIG } from './config.js';
import { defaultRNG } from './rng.js';

const W = CONFIG.arena.width;
const H = CONFIG.arena.height;
const AST = CONFIG.asteroid;
const DEG = Math.PI / 180;

export const tdx = (ax, sx) => { let d = ax - sx; if (d > W / 2) d -= W; else if (d < -W / 2) d += W; return d; };
export const tdy = (ay, sy) => { let d = ay - sy; if (d > H / 2) d -= H; else if (d < -H / 2) d += H; return d; };

export function wrap(o) {
  if (o.x < 0) o.x += W;
  else if (o.x >= W) o.x -= W;
  if (o.y < 0) o.y += H;
  else if (o.y >= H) o.y -= H;
}

export function capAsteroidSpeed(a) {
  const sp = Math.hypot(a.vx, a.vy);
  if (sp > AST.speedCap) {
    a.vx *= AST.speedCap / sp;
    a.vy *= AST.speedCap / sp;
  }
}

export function createAsteroid(size, x, y, dir, speed, rngObj = null) {
  const _rng = rngObj ?? defaultRNG;
  const s = AST.sizes[size];
  const shape = [];
  for (let i = 0; i < AST.vertices; i++) shape.push(_rng.rand(AST.jitterMin, AST.jitterMax));
  return {
    size, x, y,
    vx: Math.cos(dir) * speed,
    vy: Math.sin(dir) * speed,
    r: s.r,
    pts: s.pts,
    shape,
    angle: _rng.rand(0, Math.PI * 2),
    spin: _rng.rand(-AST.spinMax, AST.spinMax),
  };
}

// Elastic rock-rock collisions: mass ~ r^2, positional de-overlap, skip separating pairs.
export function collideAsteroids(list) {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const dx = tdx(b.x, a.x);
      const dy = tdy(b.y, a.y);
      const rr = a.r + b.r;
      let d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const ny = dy / d;
      const ma = a.r * a.r;
      const mb = b.r * b.r;
      // De-overlap proportionally to inverse mass.
      const overlap = rr - d;
      const total = ma + mb;
      a.x -= nx * overlap * (mb / total);
      a.y -= ny * overlap * (mb / total);
      b.x += nx * overlap * (ma / total);
      b.y += ny * overlap * (ma / total);
      // Impulse only when approaching.
      const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rvn >= 0) continue;
      const jImp = (-(1 + AST.restitution) * rvn) / (1 / ma + 1 / mb);
      a.vx -= (jImp / ma) * nx;
      a.vy -= (jImp / ma) * ny;
      b.vx += (jImp / mb) * nx;
      b.vy += (jImp / mb) * ny;
      capAsteroidSpeed(a);
      capAsteroidSpeed(b);
    }
  }
}
