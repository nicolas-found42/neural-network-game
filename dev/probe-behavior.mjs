// Gemba probe: what do the brains ACTUALLY do? Measures action usage per brain.
const { CONFIG } = await import('../js/config.js');
const { World } = await import('../js/game.js');
const { resetInnovation } = await import('../js/neat.js');
const { Population } = await import('../js/population.js');

const TH = CONFIG.nn.actionThreshold;
const dt = CONFIG.dt;

function censusBrains(pop, n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const net = pop.networks[i];
    const stats = { steps: 0, left: 0, right: 0, thrust: 0, fire: 0, sumOut: [0, 0, 0, 0, 0] };
    const wrapped = {
      activate: (inp) => {
        const o = net.activate(inp);
        stats.steps++;
        if (o[0] > TH) stats.left++;
        if (o[1] > TH) stats.right++;
        if (o[2] > TH) stats.thrust++;
        if (o[3] > TH) stats.fire++;
        for (let k = 0; k < 5; k++) stats.sumOut[k] += o[k];
        return o;
      },
    };
    const w = new World([wrapped]);
    let guard = 0;
    while (!w.done && guard < 25000) { w.step(dt); guard++; }
    const pct = (x) => (100 * x / stats.steps).toFixed(0);
    rows.push({
      brain: i,
      fitness: +w.agents[0].fitness.toFixed(0),
      dur: +w.time.toFixed(1),
      wave: w.wave + 1,
      L: +pct(stats.left), R: +pct(stats.right), T: +pct(stats.thrust), F: +pct(stats.fire),
      meanOut: stats.sumOut.map((s) => +(s / stats.steps).toFixed(2)),
    });
  }
  return rows;
}

function summarize(rows, label) {
  const avg = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  const turnL = rows.filter((r) => r.L > 80).length;
  const turnR = rows.filter((r) => r.R > 80).length;
  const thrust = rows.filter((r) => r.T > 20).length;
  const neverThrust = rows.filter((r) => r.T < 1).length;
  console.log(`\n=== ${label} (n=${rows.length}) ===`);
  console.log(`avg L%=${avg((r) => r.L).toFixed(0)} R%=${avg((r) => r.R).toFixed(0)} T%=${avg((r) => r.T).toFixed(0)} F%=${avg((r) => r.F).toFixed(0)}`);
  console.log(`chronic left-turners (L>80%): ${turnL}, chronic right-turners (R>80%): ${turnR}`);
  console.log(`thrust >20% of steps: ${thrust}, NEVER thrust: ${neverThrust}`);
  console.log(`mean raw outputs [L,R,T,F,M]: ${[0, 1, 2, 3, 4].map((k) => avg((r) => r.meanOut[k]).toFixed(2)).join(' ')}`);
  console.log(`avg fitness=${avg((r) => r.fitness).toFixed(0)} best=${Math.max(...rows.map((r) => r.fitness)).toFixed(0)}`);
  const top = rows.slice().sort((a, b) => b.fitness - a.fitness).slice(0, 5);
  console.log('top 5 by fitness:');
  for (const r of top) console.log(`  brain ${r.brain}: fit ${r.fitness} dur ${r.dur}s wave ${r.wave} L${r.L} R${r.R} T${r.T} F${r.F} out[${r.meanOut}]`);
}

resetInnovation();
const pop = new Population(100);
summarize(censusBrains(pop, 40), 'GEN 1 (random weights)');

// Evolve 12 generations with real solo fitness, then census again.
for (let g = 0; g < 12; g++) {
  const fits = new Array(100).fill(0);
  for (let i = 0; i < 100; i++) {
    const w = new World([pop.networks[i]]);
    let guard = 0;
    while (!w.done && guard < 25000) { w.step(dt); guard++; }
    fits[i] = w.agents[0].fitness;
  }
  pop.evolve(fits);
}
summarize(censusBrains(pop, 40), 'GEN 13 (after 12 evolutions)');
