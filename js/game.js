// Solo asteroid arena: one World evaluates ONE brain at a time (Space-Hammer-style
// sequential evaluation). The population driver in main.js feeds brains 0..99 in turn.
import { CONFIG } from './config.js';

const W = CONFIG.arena.width;
const H = CONFIG.arena.height;
const SHIP = CONFIG.ship;
const BULLET = CONFIG.bullet;
const AST = CONFIG.asteroid;
const SENS = CONFIG.sensors;
const DEG = Math.PI / 180;

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Toroidal deltas: shortest displacement on the wrapped arena. All sensing AND
// collisions use these, so rocks approaching across a seam are seen and hit.
const tdx = (ax, sx) => { let d = ax - sx; if (d > W / 2) d -= W; else if (d < -W / 2) d += W; return d; };
const tdy = (ay, sy) => { let d = ay - sy; if (d > H / 2) d -= H; else if (d < -H / 2) d += H; return d; };

function wrap(o) {
  if (o.x < 0) o.x += W;
  else if (o.x >= W) o.x -= W;
  if (o.y < 0) o.y += H;
  else if (o.y >= H) o.y -= H;
}
export class World {
  // brains: array with exactly ONE Network (or null for a no-action probe).
  constructor(brains) {
    this.time = 0;
    this.waveTime = 0;
    this.wave = 0;
    this.done = false;
    this.fitnessFinalized = false;
    this.agents = Array.from(brains, (brain) => ({
      brain,
      x: W / 2 + rand(-SHIP.spawnJitter, SHIP.spawnJitter),
      y: H / 2 + rand(-SHIP.spawnJitter, SHIP.spawnJitter),
      heading: rand(0, Math.PI * 2),
      vx: 0,
      vy: 0,
      alive: true,
      fitness: 0,
      fireCooldown: 0,
      bulletsOut: 0,
      memory: 0, // learned state: output 25 last step, fed back as input 20
      thrusting: false, // for the flame visual
      inputs: null, // last sensor frame, for the vision-ray overlay
      stats: { steps: 0, left: 0, right: 0, thrust: 0, fire: 0, speedSum: 0, cells: new Set() },
    }));
    this.asteroids = [];
    this.rockCount = AST.initialCount;
    this.#spawnWave();
    this.bullets = [];
  }

  #spawnWave() {
    const ship = this.agents[0];
    for (let i = 0; i < this.rockCount; i++) {
      let x, y;
      do {
        x = rand(0, W);
        y = rand(0, H);
      } while (
        Math.hypot(tdx(x, ship.x), tdy(y, ship.y)) < AST.initialMinDistFromShip
      );
      const s = AST.sizes.L;
      this.asteroids.push(this.#makeAsteroid('L', x, y, rand(0, Math.PI * 2), rand(s.minSpeed, s.maxSpeed)));
    }
  }

  #makeAsteroid(size, x, y, dir, speed) {
    const s = AST.sizes[size];
    const shape = [];
    for (let i = 0; i < AST.vertices; i++) shape.push(rand(AST.jitterMin, AST.jitterMax));
    return {
      size, x, y,
      vx: Math.cos(dir) * speed,
      vy: Math.sin(dir) * speed,
      r: s.r,
      pts: s.pts,
      shape,
      angle: rand(0, Math.PI * 2),
      spin: rand(-AST.spinMax, AST.spinMax),
    };
  }


  #splitAsteroid(i) {
    const a = this.asteroids[i];
    this.asteroids.splice(i, 1);
    const child = AST.sizes[a.size].child;
    if (!child) return;
    const cs = AST.sizes[child];
    const dir = Math.atan2(a.vy, a.vx);
    for (const sign of [1, -1]) {
      const d = dir + sign * rand(AST.splitAngleMin, AST.splitAngleMax) * DEG;
      const impulse = rand(cs.minSpeed, cs.maxSpeed) * AST.splitImpulseFactor;
      const c = this.#makeAsteroid(child, a.x, a.y, d, 0);
      // Momentum inheritance: parent velocity + radial spread impulse, capped.
      c.vx = a.vx + Math.cos(d) * impulse;
      c.vy = a.vy + Math.sin(d) * impulse;
      this.#capAsteroidSpeed(c);
      this.asteroids.push(c);
    }
  }

  #capAsteroidSpeed(a) {
    const sp = Math.hypot(a.vx, a.vy);
    if (sp > AST.speedCap) {
      a.vx *= AST.speedCap / sp;
      a.vy *= AST.speedCap / sp;
    }
  }

  // Elastic rock-rock collisions: mass ~ r^2, positional de-overlap, skip separating pairs.
  #collideAsteroids() {
    const list = this.asteroids;
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
        this.#capAsteroidSpeed(a);
        this.#capAsteroidSpeed(b);
      }
    }
  }

  #sense(agent) {
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
      for (const a of this.asteroids) {
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
    for (const a of this.asteroids) {
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

  step(dt) {
    this.time += dt;

    // Ships: sense -> think -> act -> move -> collide.
    const hitPad = SHIP.radius * SHIP.hitboxFactor;
    for (const agent of this.agents) {
      if (!agent.alive) continue;
      let fired = false;
      if (agent.brain) {
        const out = agent.brain.activate(this.#sense(agent));
        const left = out[0] > CONFIG.nn.actionThreshold;
        const right = out[1] > CONFIG.nn.actionThreshold;
        const turn = (right ? 1 : 0) - (left ? 1 : 0);
        agent.heading += turn * SHIP.rotateSpeed * dt;
        agent.thrusting = out[2] > CONFIG.nn.actionThreshold;
        if (agent.thrusting) {
          agent.vx += Math.cos(agent.heading) * SHIP.thrust * dt;
          agent.vy += Math.sin(agent.heading) * SHIP.thrust * dt;
        }
        if (
          out[3] > CONFIG.nn.actionThreshold &&
          agent.fireCooldown <= 0 &&
          agent.bulletsOut < BULLET.maxAlivePerShip
        ) {
          this.bullets.push({
            x: agent.x + Math.cos(agent.heading) * BULLET.noseOffset,
            y: agent.y + Math.sin(agent.heading) * BULLET.noseOffset,
            vx: agent.vx + Math.cos(agent.heading) * BULLET.speed,
            vy: agent.vy + Math.sin(agent.heading) * BULLET.speed,
            life: BULLET.life,
            owner: agent,
          });
          agent.fireCooldown = BULLET.cooldown;
          agent.bulletsOut++;
          agent.fitness -= CONFIG.fitness.bulletCost;
          agent.vx -= Math.cos(agent.heading) * BULLET.recoil;
          agent.vy -= Math.sin(agent.heading) * BULLET.recoil;
          fired = true;
        }
        agent.memory = out[4]; // fed back as input 20 next step
        // Behavior stats: action-usage histogram (for the entropy bonus + novelty
        // descriptor), speed integral, arena coverage.
        const st = agent.stats;
        st.steps++;
        if (left) st.left++;
        if (right) st.right++;
        if (agent.thrusting) st.thrust++;
        if (fired) st.fire++;
      }
      agent.fireCooldown -= dt;
      const damp = Math.max(0, 1 - SHIP.damping * dt);
      agent.vx *= damp;
      agent.vy *= damp;
      const sp = Math.hypot(agent.vx, agent.vy);
      if (sp > SHIP.maxSpeed) {
        agent.vx *= SHIP.maxSpeed / sp;
        agent.vy *= SHIP.maxSpeed / sp;
      }
      agent.x += agent.vx * dt;
      agent.y += agent.vy * dt;
      wrap(agent);
      agent.fitness += CONFIG.fitness.alivePerSecond * dt;
      agent.fitness += CONFIG.fitness.moveRate * (sp / SHIP.maxSpeed) * dt;
      agent.stats.speedSum += sp;
      agent.stats.cells.add((Math.floor(agent.x / (W / 8)) << 3) | Math.floor(agent.y / (H / 5)));
      for (const a of this.asteroids) {
        const dx = tdx(a.x, agent.x);
        const dy = tdy(a.y, agent.y);
        const rr = a.r + hitPad;
        if (dx * dx + dy * dy < rr * rr) {
          agent.alive = false;
          break;
        }
      }
    }

    // Bullets: move, expire, kill asteroids (owner scores, asteroid splits).
    for (let bi = this.bullets.length - 1; bi >= 0; bi--) {
      const b = this.bullets[bi];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      wrap(b);
      b.life -= dt;
      if (b.life <= 0) {
        this.bullets.splice(bi, 1);
        b.owner.bulletsOut--;
        continue;
      }
      for (let ai = this.asteroids.length - 1; ai >= 0; ai--) {
        const a = this.asteroids[ai];
        const dx = tdx(a.x, b.x);
        const dy = tdy(a.y, b.y);
        const rr = a.r + BULLET.radius;
        if (dx * dx + dy * dy < rr * rr) {
          this.bullets.splice(bi, 1);
          b.owner.bulletsOut--;
          b.owner.fitness += a.pts;
          this.#splitAsteroid(ai);
          break;
        }
      }
    }

    // Asteroids: move, wrap, spin (visual only).
    for (const a of this.asteroids) {
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      wrap(a);
      a.angle += a.spin * dt;
    }
    this.#collideAsteroids();

    // Wave escalation: clearing the field grows the next wave and resets the wave clock
    // (Space Hammer's difficulty ramp, applied per episode so every brain sees wave 1 first).
    if (this.asteroids.length === 0) {
      this.wave++;
      this.rockCount = Math.ceil(this.rockCount * AST.waveGrowth);
      this.#spawnWave();
      this.waveTime = 0;
    }

    this.waveTime += dt;
    this.done =
      this.agents.every((a) => !a.alive) ||
      this.waveTime >= CONFIG.world.waveTimeLimit ||
      this.time >= CONFIG.world.episodeHardCap;
    if (this.done && !this.fitnessFinalized) {
      this.fitnessFinalized = true;
      for (const agent of this.agents) this.#applyEntropyBonus(agent);
    }
  }

  // Shannon entropy over the 4 action-usage frequencies, normalized to [0,1]:
  // 1 = uses every control, ~0.6 = sprinkler (2 of 4). Sensorimotor-curiosity
  // shaping per arXiv:1006.4959 / 2608.12534.
  #applyEntropyBonus(agent) {
    const st = agent.stats;
    if (st.steps === 0) return;
    const counts = [st.left, st.right, st.thrust, st.fire];
    let h = 0;
    for (const c of counts) {
      if (c === 0) continue;
      const p = c / st.steps;
      h -= p * Math.log(p);
    }
    agent.fitness += CONFIG.fitness.actionEntropyBonus * (h / Math.log(4));
  }

  // Normalized behavior descriptor for the novelty archive:
  // [usageL, usageR, usageT, usageF, coverage8x5, meanSpeed/maxSpeed, min(waves,5)/5].
  agentBehavior(agent = this.agents[0]) {
    const st = agent.stats;
    const n = Math.max(1, st.steps);
    return [
      st.left / n, st.right / n, st.thrust / n, st.fire / n,
      st.cells.size / 40,
      st.speedSum / n / SHIP.maxSpeed,
      Math.min(this.wave, 5) / 5,
    ];
  }
}
