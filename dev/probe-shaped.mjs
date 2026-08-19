// A/B: same census as before, now with shaping fitness (movement + entropy inside World,
// novelty added exactly like main.js). Expect: symmetric L/R, thrust up, fire down.
const { CONFIG } = await import('../js/config.js');
const { World } = await import('../js/game.js');
const { resetInnovation } = await import('../js/neat.js');
const { Population, NoveltyArchive } = await import('../js/population.js');

const TH = CONFIG.nn.actionThreshold;
const dt = CONFIG.dt;

function runEpisode(pop, i, archive, tally) {
  const net = pop.networks[i];
  const stats = { steps: 0, left: 0, right: 0, thrust: 0, fire: 0 };
  const wrapped = {
    activate: (inp) => {
      const o = net.activate(inp);
      stats.steps++;
      if (o[0] > TH) stats.left++;
      if (o[1] > TH) stats.right++;
      if (o[2] > TH) stats.thrust++;
      if (o[3] > TH) stats.fire++;
      return o;
    },
  };
  const w = new World([wrapped]);
  let guard = 0;
  while (!w.done && guard < 25000) { w.step(dt); guard++; }
  const behavior = w.agentBehavior();
  const fit = w.agents[0].fitness + archive.bonusFor(pop.generation) * archive.novelty(behavior);
  archive.add(behavior);
  if (tally) {
    const pct = (x) => (100 * x / Math.max(1, stats.steps)).toFixed(0);
    return { fitness: fit, wave: w.wave + 1, dur: +w.time.toFixed(0), L: +pct(stats.left), R: +pct(stats.right), T: +pct(stats.thrust), F: +pct(stats.fire) };
  }
  return fit;
}

function summarize(rows, label) {
  const avg = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  console.log(`\n=== ${label} (n=${rows.length}) ===`);
  console.log(`avg L%=${avg((r) => r.L).toFixed(0)} R%=${avg((r) => r.R).toFixed(0)} T%=${avg((r) => r.T).toFixed(0)} F%=${avg((r) => r.F).toFixed(0)}`);
  console.log(`chronic L>80%: ${rows.filter((r) => r.L > 80).length}, chronic R>80%: ${rows.filter((r) => r.R > 80).length}`);
  console.log(`thrust>20%: ${rows.filter((r) => r.T > 20).length}, thrust<1%: ${rows.filter((r) => r.T < 1).length}`);
  console.log(`avg fit=${avg((r) => r.fitness).toFixed(0)} best=${Math.max(...rows.map((r) => r.fitness)).toFixed(0)} avg wave=${avg((r) => r.wave).toFixed(2)}`);
  const top = rows.slice().sort((a, b) => b.fitness - a.fitness).slice(0, 5);
  for (const r of top) console.log(`  top: fit ${r.fitness.toFixed(0)} wave ${r.wave} L${r.L} R${r.R} T${r.T} F${r.F}`);
}

resetInnovation();
const pop = new Population(100);
const archive = new NoveltyArchive();
summarize(Array.from({ length: 40 }, (_, i) => runEpisode(pop, i, archive, true)), 'SHAPED GEN 1');

for (let g = 0; g < 12; g++) {
  const fits = Array.from({ length: 100 }, (_, i) => runEpisode(pop, i, archive, false));
  pop.evolve(fits);
}
summarize(Array.from({ length: 40 }, (_, i) => runEpisode(pop, i, archive, true)), 'SHAPED GEN 13');
