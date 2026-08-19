// Headless generation driver: the Phase 2 tuning evidence tool and the Phase 1
// determinism oracle. Mirrors main.js (endEpisode + startNextGeneration) exactly:
// same seeded stream, same banking order, same gate rules, same console line.
// Usage: node dev/evolve.mjs --seed 5 --gens 40
import { CONFIG } from '../js/config.js';
import { World } from '../js/game.js';
import { resetInnovation } from '../js/neat.js';
import { Population, NoveltyArchive } from '../js/population.js';
import { setSeed } from '../js/rng.js';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? Number(args[i + 1]) : def;
};
const seed = arg('--seed', 1);
const gens = arg('--gens', 40);

setSeed(seed);
resetInnovation();

const POP_SIZE = CONFIG.neat.popSize;
const pop = new Population(POP_SIZE);
const archive = new NoveltyArchive();
const gate = { bestAT: 0, bestWave: 0, bestPts: 0, medians: [], count: 0, tripped: false };

const dt = CONFIG.dt;
const STEP_CAP = Math.ceil(CONFIG.world.episodeHardCap / dt) + 10;

for (let g = 1; g <= gens; g++) {
  const fitnesses = new Array(POP_SIZE).fill(0);
  const genRecords = [];
  for (let i = 0; i < POP_SIZE; i++) {
    const world = new World([pop.networks[i]]);
    let steps = 0;
    while (!world.done && steps < STEP_CAP) {
      world.step(dt);
      steps++;
    }
    // Mirrors main.js endEpisode exactly: bank shaped fitness + novelty bonus,
    // then archive (eviction may draw from the stream — keep the order).
    const behavior = world.agentBehavior();
    fitnesses[i] = world.agents[0].fitness + archive.bonusFor(pop.generation) * archive.novelty(behavior);
    archive.add(behavior);
    genRecords.push({
      at: world.agents[0].stats.aliveTime,
      wave: world.wave,
      pts: world.agents[0].stats.rockPts,
    });
  }

  // Gen close: raw-competence gate + console line, then evolve (same rules and
  // order as main.js startNextGeneration).
  const genBest = Math.max(...fitnesses);
  const ats = genRecords.map((r) => r.at);
  const bestAT = Math.max(...ats);
  const bestWave = Math.max(...genRecords.map((r) => r.wave));
  const bestPts = Math.max(...genRecords.map((r) => r.pts));
  const sorted = ats.slice().sort((a, b) => a - b);
  const medianAT = sorted[Math.floor(sorted.length / 2)];
  const newBest = bestAT > gate.bestAT || bestWave > gate.bestWave || bestPts > gate.bestPts;
  gate.bestAT = Math.max(gate.bestAT, bestAT);
  gate.bestWave = Math.max(gate.bestWave, bestWave);
  gate.bestPts = Math.max(gate.bestPts, bestPts);
  gate.medians.push(medianAT);
  if (gate.medians.length > 15) gate.medians.shift();
  const stagnant = !newBest && medianAT < 1.10 * gate.medians[0];
  gate.count = stagnant ? gate.count + 1 : 0;
  if (gate.count >= 15 && !gate.tripped) {
    gate.tripped = true;
    console.log('GATE TRIPPED gen', pop.generation);
  }
  console.log(
    'gen', pop.generation, 'best', genBest.toFixed(1),
    'AT', bestAT.toFixed(1), 'wave', bestWave, 'pts', bestPts,
    'medAT', medianAT.toFixed(1), 'gate', gate.count + '/15'
  );
  pop.evolve(fitnesses);
}
