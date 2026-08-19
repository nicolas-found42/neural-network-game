// Headless generation driver: the Phase 2 tuning evidence tool and the Phase 1
// determinism oracle. Now a thin adapter over EvolutionRunner — same seeded
// stream, same banking order, same gate rules as the browser rAF adapter.
// Usage: node dev/evolve.mjs --seed 5 --gens 40
import { CONFIG } from '../js/config.js';
import { InnovationTracker } from '../js/neat.js';
import { createRNG, setSeed } from '../js/rng.js';
import { EvolutionRunner } from '../js/evolution.js';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? Number(args[i + 1]) : def;
};
const seed = arg('--seed', 1);
const gens = arg('--gens', 40);

// Legacy global kept for any module still reading global rand, but the
// explicit seam is the shared RNG instance threaded to Population/World/Archive.
setSeed(seed);
const rng = createRNG(seed);
const tracker = new InnovationTracker();

const runner = new EvolutionRunner({ rng, tracker, seed });

for (let g = 1; g <= gens; g++) {
  runner.runGenerationSync();
}
