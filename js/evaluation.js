// Evaluation: entropy curiosity + behavior descriptor + novelty archive.
// Deep module owning all curiosity shaping (arXiv:1006.4959, 2608.12534,
// 1902.03142, 2209.03618) behind a small interface. World produces raw stats;
// main.js calls evaluate via the EvolutionRunner seam.
import { CONFIG } from './config.js';
import { defaultRNG } from './rng.js';

const SHIP = CONFIG.ship;

// Shannon entropy over the 4 action-usage frequencies, normalized to [0,1]:
// 1 = uses every control, ~0.6 = sprinkler (2 of 4). Sensorimotor-curiosity
// shaping per arXiv:1006.4959 / 2608.12534.
export function applyEntropyBonus(agent) {
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
export function buildBehavior(agent, wave) {
  const st = agent.stats;
  const n = Math.max(1, st.steps);
  return [
    st.left / n, st.right / n, st.thrust / n, st.fire / n,
    st.cells.size / 40,
    st.speedSum / n / SHIP.maxSpeed,
    Math.min(wave, 5) / 5,
  ];
}

// Bounded novelty archive over behavior descriptors (arXiv:1902.03142 action-based
// novelty; decaying bonus per arXiv:2209.03618 adaptive explore/exploit).
export class NoveltyArchive {
  constructor(rng = null) {
    this.rng = rng ?? defaultRNG;
    this.entries = [];
  }

  // Mean distance to the k nearest archived behaviors; 0 when archive is empty.
  novelty(behavior) {
    if (this.entries.length === 0) return 0;
    const k = Math.min(CONFIG.fitness.noveltyK, this.entries.length);
    const dists = this.entries.map((e) => {
      let s = 0;
      for (let i = 0; i < behavior.length; i++) {
        const d = behavior[i] - e[i];
        s += d * d;
      }
      return Math.sqrt(s);
    });
    dists.sort((a, b) => a - b);
    let sum = 0;
    for (let i = 0; i < k; i++) sum += dists[i];
    return sum / k;
  }

  add(behavior) {
    this.entries.push(behavior);
    if (this.entries.length > CONFIG.fitness.archiveSize) {
      // Random eviction keeps the archive a time-decaying sample of behaviors.
      this.entries.splice(this.rng.randInt(this.entries.length), 1);
    }
  }

  // Bonus weight for a given generation: linear decay to a floor fraction.
  bonusFor(generation) {
    const F = CONFIG.fitness;
    const decay = Math.max(F.noveltyFloorFrac, 1 - generation / F.noveltyDecayGens);
    return F.noveltyBonus * decay;
  }
}

// Deep façade: one seam owning archive + behavior + bonus.
// World still computes raw fitness (alive + move + points); this module
// adds the curiosity shaping on top.
export class Evaluation {
  constructor(rng = null) {
    this.rng = rng ?? defaultRNG;
    this.archive = new NoveltyArchive(this.rng);
  }

  novelty(behavior) {
    return this.archive.novelty(behavior);
  }

  bonusFor(generation) {
    return this.archive.bonusFor(generation);
  }

  add(behavior) {
    return this.archive.add(behavior);
  }

  behavior(agent, wave) {
    return buildBehavior(agent, wave);
  }

  // Raw entropy is already folded into agent.fitness by World at episode end;
  // this adds the decaying novelty bonus.
  evaluate(agent, wave, generation) {
    const beh = buildBehavior(agent, wave);
    return agent.fitness + this.archive.bonusFor(generation) * this.archive.novelty(beh);
  }

  // Convenience: evaluate and bank the behavior in one call.
  evaluateAndAdd(agent, wave, generation) {
    const beh = buildBehavior(agent, wave);
    const novelty = this.archive.novelty(beh);
    const fitness = agent.fitness + this.archive.bonusFor(generation) * novelty;
    this.archive.add(beh);
    return { fitness, behavior: beh, novelty };
  }
}
