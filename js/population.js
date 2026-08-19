// Population lifecycle: speciation, dynamic delta threshold, stagnation culling, reproduction.
import { CONFIG } from './config.js';
import { Genome, Network, genomeDistance } from './neat.js';
import { rng, randInt } from './rng.js';

const N = CONFIG.neat;

let nextSpeciesId = 1;

// Integer quotas summing exactly to `total`, proportional to weights (largest remainder).
function largestRemainder(weights, total) {
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((s, v) => s + v, 0);
  if (sum <= 0) {
    // All-adjusted non-positive: fall back to uniform so the population survives.
    const base = Math.floor(total / n);
    const out = Array(n).fill(base);
    for (let i = 0; i < total - base * n; i++) out[i]++;
    return out;
  }
  const exact = weights.map((w) => (w / sum) * total);
  const out = exact.map(Math.floor);
  let rem = total - out.reduce((s, v) => s + v, 0);
  const frac = exact.map((v, i) => [v - Math.floor(v), i]).sort((x, y) => y[0] - x[0]);
  for (let i = 0; i < rem; i++) out[frac[i % n][1]]++;
  return out;
}

// Bounded novelty archive over behavior descriptors (arXiv:1902.03142 action-based
// novelty; decaying bonus per arXiv:2209.03618 adaptive explore/exploit).
export class NoveltyArchive {
  constructor() {
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
      this.entries.splice(randInt(this.entries.length), 1);
    }
  }

  // Bonus weight for a given generation: linear decay to a floor fraction.
  bonusFor(generation) {
    const F = CONFIG.fitness;
    const decay = Math.max(F.noveltyFloorFrac, 1 - generation / F.noveltyDecayGens);
    return F.noveltyBonus * decay;
  }
}
export class Population {
  constructor(size = N.popSize) {
    this.size = size;
    this.genomes = Array.from({ length: size }, () => new Genome());
    this.networks = this.genomes.map((g) => Network.fromGenome(g));
    this.generation = 1;
    this.history = []; // {best, avg} per generation
    this.bestEver = { fitness: -Infinity, gen: 0, speciesId: null };
    this.species = []; // {id, rep, members, bestFitness, stagnation, survivors, adjusted}
    this.deltaTarget = N.deltaTargetInit;
  }

  evolve(fitnesses) {
    const size = fitnesses.length;
    const best = Math.max(...fitnesses);
    const avg = fitnesses.reduce((s, v) => s + v, 0) / size;
    this.history.push({ best, avg });

    // --- Speciate against representatives carried over from the previous generation.
    for (const s of this.species) s.members = [];
    const genomeSpecies = new Array(size);
    for (let i = 0; i < size; i++) {
      const g = this.genomes[i];
      let sp = null;
      for (const s of this.species) {
        if (genomeDistance(g, s.rep) < this.deltaTarget) {
          sp = s;
          break;
        }
      }
      if (!sp) {
        sp = { id: nextSpeciesId++, rep: g, bestFitness: -Infinity, stagnation: 0, members: [] };
        this.species.push(sp);
      }
      sp.members.push({ g, f: fitnesses[i] });
      genomeSpecies[i] = sp;
    }

    // --- Global best bookkeeping (before stats so the holder species is identifiable).
    let bi = 0;
    for (let i = 1; i < size; i++) if (fitnesses[i] > fitnesses[bi]) bi = i;
    if (fitnesses[bi] > this.bestEver.fitness) {
      this.bestEver = { fitness: fitnesses[bi], gen: this.generation, speciesId: genomeSpecies[bi].id };
    }

    // --- Species stats: stagnation counters.
    for (const s of this.species) {
      const memberBest = Math.max(...s.members.map((m) => m.f));
      if (memberBest > s.bestFitness) {
        s.bestFitness = memberBest;
        s.stagnation = 0;
      } else {
        s.stagnation++;
      }
    }

    // --- Dynamic compatibility threshold.
    if (this.species.length > N.speciesCountMax) {
      this.deltaTarget = Math.min(N.deltaMax, this.deltaTarget + N.deltaStep);
    } else if (this.species.length < N.speciesCountMin) {
      this.deltaTarget = Math.max(N.deltaMin, this.deltaTarget - N.deltaStep);
    }

    // --- Stagnation culling: never cull the global-best species; never drop below 2 species.
    const viable = this.species.filter(
      (s) => s.stagnation < N.stagnationLimit || s.id === this.bestEver.speciesId
    );
    if (viable.length >= 2) this.species = viable;

    // --- Reproduction setup: survivors, champions, adjusted fitness.
    const next = [];
    for (const s of this.species) {
      s.members.sort((x, y) => y.f - x.f); // fittest first
      s.championCopied = false;
      if (s.members.length >= N.championMinSize) {
        next.push(s.members[0].g.copy()); // champion copied unchanged
        s.championCopied = true;
      }
      const survivors = Math.ceil(s.members.length * (1 - N.survivalFraction));
      s.survivors = s.members.slice(0, survivors);
      const avgF = s.members.reduce((t, m) => t + m.f, 0) / s.members.length;
      s.adjusted = avgF / s.members.length;
    }

    // --- Offspring quota per species, proportional to adjusted fitness.
    const quota = largestRemainder(
      this.species.map((s) => Math.max(s.adjusted, 0)),
      this.size - next.length
    );
    this.species.forEach((s, idx) => {
      for (let k = 0; k < quota[idx]; k++) next.push(this.#offspring(s));
    });

    // --- Safety fill (rounding / degenerate cases), then exact size.
    const pool = this.species.flatMap((s) => s.survivors);
    while (next.length < this.size && pool.length) {
      next.push(pool[randInt(pool.length)].g.copy());
    }
    next.length = this.size;

    // --- Representatives carried over: random member of each producing species.
    this.species = this.species.filter((s, idx) => s.championCopied || quota[idx] > 0);
    for (const s of this.species) {
      s.rep = s.members[randInt(s.members.length)].g;
    }

    this.genomes = next;
    this.networks = this.genomes.map((g) => Network.fromGenome(g));
    this.generation++;
  }

  #offspring(s) {
    const pick = () => s.survivors[randInt(s.survivors.length)];
    let child;
    if (rng() < N.crossoverRate) {
      const a = pick();
      const b = pick();
      if (a === b) {
        child = a.g.copy();
      } else {
        const aFitter = a.f > b.f ? true : a.f < b.f ? false : null;
        child = Genome.crossover(a.g, b.g, aFitter);
      }
    } else {
      child = pick().g.copy();
    }
    if (rng() < N.addNodeRate) child.mutateAddNode();
    if (rng() < N.addConnectionRate) child.mutateAddConnection();
    child.mutateWeights();
    return child;
  }
}
