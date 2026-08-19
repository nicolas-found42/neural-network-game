// EvolutionRunner: deep module owning the solo evaluation lifecycle.
// One seam, two adapters: browser rAF (main.js) and headless (dev/evolve.mjs).
// Interface is small (tick, generation, best) over ~120 LOC hidden.
import { CONFIG } from './config.js';
import { World } from './game.js';
import { Population } from './population.js';
import { Evaluation } from './evaluation.js';

const POP_SIZE = CONFIG.neat.popSize;

export class EvolutionRunner {
  constructor(opts = {}) {
    // opts: { rng, tracker, popSize, seed, champGenome, champNet, showcase }
    this.rng = opts.rng ?? null;
    this.tracker = opts.tracker ?? null;
    this.popSize = opts.popSize ?? POP_SIZE;
    this.seed = opts.seed ?? null;
    this.showcase = !!opts.showcase;
    this.champGenome = opts.champGenome ?? null;
    this.champNet = opts.champNet ?? null;

    this.pop = new Population(this.popSize, { rng: this.rng, tracker: this.tracker });
    this.evaluation = new Evaluation(this.rng);
    // Keep legacy name for adapters that expect archive.
    this.archive = this.evaluation.archive;
    this.fitnesses = new Array(this.popSize).fill(0);
    this.brainIdx = 0;
    this.world = new World([this.showcase ? this.champNet : this.pop.networks[0]], { rng: this.rng });
    this.currentBrain = this.showcase
      ? { genome: this.champGenome, network: this.champNet }
      : { genome: this.pop.genomes[0], network: this.pop.networks[0] };
    this.bestRun = null;
    this.gate = { bestAT: 0, bestWave: 0, bestPts: 0, medians: [], count: 0, tripped: false, trippedGen: 0 };
    this.genRecords = [];
    this.overlay = null;
    this.stepAcc = 0;
    this._speed = 100;
  }

  get generation() {
    return this.pop.generation;
  }

  get best() {
    return this.bestRun;
  }

  loadBrain(i) {
    this.brainIdx = i;
    this.world = new World([this.showcase ? this.champNet : this.pop.networks[i]], { rng: this.rng });
    this.currentBrain = this.showcase
      ? { genome: this.champGenome, network: this.champNet }
      : { genome: this.pop.genomes[i], network: this.pop.networks[i] };
  }

  // Bank the finished brain's fitness + novelty, then advance to the next brain
  // or set the overlay if generation is complete. Speed hint controls overlay duration.
  endEpisode(speedHint = this._speed) {
    const behavior = this.world.agentBehavior();
    const gen = this.pop.generation;
    const novelty = this.evaluation.archive.novelty(behavior);
    const bonus = this.evaluation.archive.bonusFor(gen);
    this.fitnesses[this.brainIdx] = this.world.agents[0].fitness + bonus * novelty;
    this.evaluation.archive.add(behavior);
    this.genRecords.push({
      at: this.world.agents[0].stats.aliveTime,
      wave: this.world.wave,
      pts: this.world.agents[0].stats.rockPts,
    });
    if (!this.bestRun || this.fitnesses[this.brainIdx] > this.bestRun.fitness) {
      this.bestRun = { genome: this.currentBrain.genome, fitness: this.fitnesses[this.brainIdx], gen };
    }
    if (this.brainIdx + 1 >= this.popSize) {
      this.overlay = {
        text: `Gen ${this.pop.generation} complete — best ${Math.max(...this.fitnesses).toFixed(1)}`,
        remaining: Math.max(0.03, CONFIG.world.overlaySeconds / (speedHint || 1)),
      };
    } else {
      this.loadBrain(this.brainIdx + 1);
    }
  }

  // Close out the generation: gate metrics from raw-competence records, then evolve
  // (showcase mode replays the champion instead of evolving).
  startNextGeneration() {
    const genBest = Math.max(...this.fitnesses);
    if (!this.showcase && this.genRecords.length) {
      const ats = this.genRecords.map((r) => r.at);
      const bestAT = Math.max(...ats);
      const bestWave = Math.max(...this.genRecords.map((r) => r.wave));
      const bestPts = Math.max(...this.genRecords.map((r) => r.pts));
      const sorted = ats.slice().sort((a, b) => a - b);
      const medianAT = sorted[Math.floor(sorted.length / 2)];
      const newBest = bestAT > this.gate.bestAT || bestWave > this.gate.bestWave || bestPts > this.gate.bestPts;
      this.gate.bestAT = Math.max(this.gate.bestAT, bestAT);
      this.gate.bestWave = Math.max(this.gate.bestWave, bestWave);
      this.gate.bestPts = Math.max(this.gate.bestPts, bestPts);
      this.gate.medians.push(medianAT);
      if (this.gate.medians.length > 15) this.gate.medians.shift();
      const stagnant = !newBest && medianAT < 1.10 * this.gate.medians[0];
      this.gate.count = stagnant ? this.gate.count + 1 : 0;
      if (this.gate.count >= 15 && !this.gate.tripped) {
        this.gate.tripped = true;
        this.gate.trippedGen = this.pop.generation;
      }
      console.log(
        'gen', this.pop.generation, 'best', genBest.toFixed(1),
        'AT', bestAT.toFixed(1), 'wave', bestWave, 'pts', bestPts,
        'medAT', medianAT.toFixed(1), 'gate', this.gate.count + '/15'
      );
    }
    this.genRecords = [];
    if (this.showcase) {
      const genAvg = this.fitnesses.reduce((s, v) => s + v, 0) / this.popSize;
      this.pop.history.push({ best: genBest, avg: genAvg });
      this.pop.generation++;
    } else {
      this.pop.evolve(this.fitnesses);
    }
    this.fitnesses = new Array(this.popSize).fill(0);
    this.loadBrain(0);
  }

  // Run up to `steps` sim steps within the frame budget. Brain transitions and
  // generation ends are handled inline, so a frame is never wasted mid-budget.
  runSteps(steps, deadline = Infinity) {
    let ran = 0;
    while (ran < steps) {
      if (this.world.done) {
        this.endEpisode(this._speed);
        if (this.overlay) break;
        continue;
      }
      this.world.step(CONFIG.dt);
      ran++;
      if ((ran & 1023) === 0) {
        const now = typeof performance !== 'undefined' ? performance.now() : 0;
        if (now >= deadline) break;
      }
    }
    return ran;
  }

  // Deterministic accumulator tick: one wall frame = 1/60 wall-second by fiat.
  // Handles overlay countdown and step budgeting.
  tick(realDt, speed) {
    this._speed = speed;
    if (this.overlay) {
      this.overlay.remaining -= realDt;
      if (this.overlay.remaining <= 0) {
        this.startNextGeneration();
        this.overlay = null;
      }
      return { ran: 0, overlay: !!this.overlay };
    }
    this.stepAcc += speed / 60;
    let steps = Math.floor(this.stepAcc / CONFIG.dt);
    if (steps > CONFIG.render.maxStepsPerFrame) {
      steps = CONFIG.render.maxStepsPerFrame;
      this.stepAcc = 0;
    }
    const deadline = typeof performance !== 'undefined' ? performance.now() + CONFIG.render.frameBudgetMs : Infinity;
    const ran = this.runSteps(steps, deadline);
    // eff tracking left to adapter (main.js keeps effSim/effWall)
    this.stepAcc -= ran * CONFIG.dt;
    if (ran < steps) this.stepAcc = 0;
    return { ran, overlay: !!this.overlay };
  }

  // Headless helper: run one brain synchronously to completion and bank it.
  // Used by evolve.mjs and tests; bypasses overlay timing.
  runOneBrainSync() {
    const cap = Math.ceil(CONFIG.world.episodeHardCap / CONFIG.dt) + 10;
    let steps = 0;
    while (!this.world.done && steps < cap) {
      this.world.step(CONFIG.dt);
      steps++;
    }
    this.endEpisode(this._speed);
    return steps;
  }

  // Headless helper: run a full generation synchronously (all brains).
  // Immediately closes the generation without overlay delay.
  runGenerationSync() {
    const startGen = this.pop.generation;
    for (let i = 0; i < this.popSize; i++) {
      if (this.pop.generation !== startGen) break;
      // Ensure we are on the correct brain; first brain already loaded.
      if (i !== this.brainIdx) this.loadBrain(i);
      const cap = Math.ceil(CONFIG.world.episodeHardCap / CONFIG.dt) + 10;
      let steps = 0;
      while (!this.world.done && steps < cap) {
        this.world.step(CONFIG.dt);
        steps++;
      }
      this.endEpisode(this._speed);
      if (this.overlay) {
        this.startNextGeneration();
        this.overlay = null;
        break;
      }
    }
  }

  // Reset for Restart button: recreate population and state but keep same rng/tracker generation.
  // Adapter is expected to create fresh RNG/tracker if seed changes.
  reset({ rng = this.rng, tracker = this.tracker, seed = this.seed, champGenome = this.champGenome, champNet = this.champNet, showcase = this.showcase } = {}) {
    this.rng = rng;
    this.tracker = tracker;
    this.seed = seed;
    this.champGenome = champGenome;
    this.champNet = champNet;
    this.showcase = showcase;
    this.pop = new Population(this.popSize, { rng: this.rng, tracker: this.tracker });
    this.evaluation = new Evaluation(this.rng);
    this.archive = this.evaluation.archive;
    this.fitnesses = new Array(this.popSize).fill(0);
    this.genRecords = [];
    this.bestRun = null;
    this.gate = { bestAT: 0, bestWave: 0, bestPts: 0, medians: [], count: 0, tripped: false, trippedGen: 0 };
    this.overlay = null;
    this.stepAcc = 0;
    this.loadBrain(0);
  }
}
