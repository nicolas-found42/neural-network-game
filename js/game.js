// Solo asteroid arena: one World evaluates ONE brain at a time (Space-Hammer-style
// sequential evaluation). The population driver in main.js feeds brains 0..99 in turn.
import { CONFIG } from './config.js';
import { defaultRNG } from './rng.js';
import { sense, tdx, tdy } from './sensors.js';
import { wrap, capAsteroidSpeed, createAsteroid, collideAsteroids } from './physics.js';
import { applyEntropyBonus, buildBehavior } from './evaluation.js';

const W = CONFIG.arena.width;
const H = CONFIG.arena.height;
const SHIP = CONFIG.ship;
const BULLET = CONFIG.bullet;
const AST = CONFIG.asteroid;
const DEG = Math.PI / 180;

// Re-export toroidal helpers for any external probe that imported them via game.js
export { tdx, tdy, wrap };

export class World {
  // brains: array with exactly ONE Network (or null for a no-action probe).
  // Second arg is optional RNG seam: { rng } or direct rng object. Falls back
  // to the global seeded stream for backward compat.
  constructor(brains, rngOrOpts = null) {
    let rng = null;
    if (rngOrOpts && typeof rngOrOpts.rng === 'function') rng = rngOrOpts;
    else if (rngOrOpts && rngOrOpts.rng) rng = rngOrOpts.rng;
    else if (rngOrOpts && typeof rngOrOpts.rand === 'function') rng = rngOrOpts;
    this.rng = rng ?? defaultRNG;
    this.time = 0;
    this.waveTime = 0;
    this.wave = 0;
    this.done = false;
    this.fitnessFinalized = false;
    this.agents = Array.from(brains, (brain) => ({
      brain,
      x: W / 2 + this.rng.rand(-SHIP.spawnJitter, SHIP.spawnJitter),
      y: H / 2 + this.rng.rand(-SHIP.spawnJitter, SHIP.spawnJitter),
      heading: this.rng.rand(0, Math.PI * 2),
      vx: 0,
      vy: 0,
      alive: true,
      fitness: 0,
      fireCooldown: 0,
      bulletsOut: 0,
      memory: 0, // learned state: output 25 last step, fed back as input 20
      thrusting: false, // for the flame visual
      inputs: null, // last sensor frame, for the vision-ray overlay
      stats: { steps: 0, left: 0, right: 0, thrust: 0, fire: 0, speedSum: 0, cells: new Set(), aliveTime: 0, rockPts: 0 },
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
        x = this.rng.rand(0, W);
        y = this.rng.rand(0, H);
      } while (
        Math.hypot(tdx(x, ship.x), tdy(y, ship.y)) < AST.initialMinDistFromShip
      );
      const s = AST.sizes.L;
      this.asteroids.push(this.#makeAsteroid('L', x, y, this.rng.rand(0, Math.PI * 2), this.rng.rand(s.minSpeed, s.maxSpeed)));
    }
  }

  #makeAsteroid(size, x, y, dir, speed) {
    return createAsteroid(size, x, y, dir, speed, this.rng);
  }

  #splitAsteroid(i) {
    const a = this.asteroids[i];
    this.asteroids.splice(i, 1);
    const child = AST.sizes[a.size].child;
    if (!child) return;
    const cs = AST.sizes[child];
    const dir = Math.atan2(a.vy, a.vx);
    for (const sign of [1, -1]) {
      const d = dir + sign * this.rng.rand(AST.splitAngleMin, AST.splitAngleMax) * DEG;
      const impulse = this.rng.rand(cs.minSpeed, cs.maxSpeed) * AST.splitImpulseFactor;
      const c = this.#makeAsteroid(child, a.x, a.y, d, 0);
      // Momentum inheritance: parent velocity + radial spread impulse, capped.
      c.vx = a.vx + Math.cos(d) * impulse;
      c.vy = a.vy + Math.sin(d) * impulse;
      capAsteroidSpeed(c);
      this.asteroids.push(c);
    }
  }

  #capAsteroidSpeed(a) {
    capAsteroidSpeed(a);
  }

  // Internal seam: elastic rock-rock collisions delegated to physics module.
  // Exposed via method for backward compat (verify probes World indirectly).
  #collideAsteroids() {
    collideAsteroids(this.asteroids);
  }

  // Internal seam: sensing delegated to sensors module.
  #sense(agent) {
    return sense(agent, this.asteroids);
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
      agent.stats.aliveTime += dt;
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
          b.owner.stats.rockPts += a.pts;
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

  // Internal seam: entropy bonus delegated to evaluation module.
  #applyEntropyBonus(agent) {
    applyEntropyBonus(agent);
  }

  // Normalized behavior descriptor for the novelty archive:
  // [usageL, usageR, usageT, usageF, coverage8x5, meanSpeed/maxSpeed, min(waves,5)/5].
  agentBehavior(agent = this.agents[0]) {
    return buildBehavior(agent, this.wave);
  }
}
