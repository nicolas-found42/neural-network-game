// Owns Population + the solo evaluation loop (brains 0..99, one World each); rAF loop
// with log speed slider (1x..10000x)/pause; generation lifecycle; controls.
import { CONFIG } from './config.js';
import { World } from './game.js';
import { Genome, Network, resetInnovation } from './neat.js';
import { Population, NoveltyArchive } from './population.js';
import { renderArena, renderOverlay, renderHUD, renderChart, renderNetwork, setupHiDPI } from './render.js';
import { setSeed } from './rng.js';

const arena = document.getElementById('arena');
const hud = document.getElementById('hud');
const chartCanvas = document.getElementById('chart');
const netCanvas = document.getElementById('net');
const chartCtx = chartCanvas.getContext('2d');
const netCtx = netCanvas.getContext('2d');
const ctx = arena.getContext('2d');
const btnPause = document.getElementById('btnPause');

// --- Seed & URL ownership: ?seed=N pins the run (deterministic replay from gen 0),
// ?champ=<repo-relative path> showcases a champion genome instead of evolving.
const params = new URLSearchParams(location.search);
const urlSeed = params.has('seed') ? (Number.parseInt(params.get('seed'), 10) >>> 0) : null;
const champPath = params.get('champ');
// Seed choice is not part of the run: pristine Math.random, never the seeded stream.
const newRandomSeed = () => Math.floor(Math.random() * 0x7FFFFFFF);

const POP_SIZE = CONFIG.neat.popSize;
let overlay = null; // { text, remaining }
let showcase = false;
let champGenome = null;
let champNet = null;

let seed = urlSeed ?? newRandomSeed();
setSeed(seed);

if (champPath) {
  try {
    champGenome = Genome.fromJSON(await (await fetch(champPath)).json());
    champNet = Network.fromGenome(champGenome);
    showcase = true;
  } catch (e) {
    console.error('champion failed to load', e);
    overlay = { text: 'champion failed to load — fresh run', remaining: 3 };
  }
}

// A spontaneously started run is shareable retroactively: the chosen seed goes into
// the URL (preserving any champ param). ?seed= runs keep their pinned seed.
if (!urlSeed) {
  history.replaceState(
    null,
    '',
    '?' + (champPath ? 'champ=' + encodeURIComponent(champPath) + '&' : '') + 'seed=' + seed
  );
}

let pop = new Population(POP_SIZE); // showcase too: keeps chart/HUD alive; its genomes are never evaluated
let archive = new NoveltyArchive();
let brainIdx = 0; // which brain of the current generation is under evaluation
let fitnesses = new Array(POP_SIZE).fill(0);
let world = new World([showcase ? champNet : pop.networks[0]]); // solo: one brain per World
let currentBrain = showcase
  ? { genome: champGenome, network: champNet }
  : { genome: pop.genomes[0], network: pop.networks[0] };
let bestRun = null; // { genome, fitness, gen } — best banked fitness this run (⬇ Champ source)
// Raw-competence gate, separate from shaped fitness: stagnation detector over
// alive-time / wave / rock-points. Trips after 15 consecutive stagnant generations.
const gate = { bestAT: 0, bestWave: 0, bestPts: 0, medians: [], count: 0, tripped: false, trippedGen: 0 };
let genRecords = []; // { at, wave, pts } per brain of the running generation
let paused = false;
let speed = 100; // sim seconds per wall second, 1..CONFIG.render.speedMax
let showRays = false;
let lastFrameTime = performance.now();
let panelTimer = 0;
let frameCount = 0;
let fpsFrames = 0;
let fpsAccum = 0;
let stepAcc = 0; // fractional sim seconds owed (deterministic step accumulator)
let effSim = 0; // sim seconds stepped in the current measurement window
let effWall = 0; // wall seconds in the current measurement window
const speedEff = document.getElementById('speedEff');

// Fitted HiDPI layout: arena backing = fitted CSS size * DPR (capped), transform = DPR*scale
// so drawing in logical 960×600 always fills the backing crisply. Chart/net are fixed.
let layoutRaf = 0;
function applyHiDPIAndFit() {
  const wrap = document.getElementById('arenaWrap');
  const scale = Math.min(
    wrap.clientWidth / CONFIG.arena.width,
    wrap.clientHeight / CONFIG.arena.height
  );
  const cssW = Math.floor(CONFIG.arena.width * scale);
  const cssH = Math.floor(CONFIG.arena.height * scale);
  setupHiDPI(arena, cssW, cssH, CONFIG.arena.width, CONFIG.arena.height);
  setupHiDPI(chartCanvas, CONFIG.render.chart.width, CONFIG.render.chart.height);
  setupHiDPI(netCanvas, CONFIG.render.network.width, CONFIG.render.network.height);
}
function scheduleLayout() {
  if (layoutRaf) return;
  layoutRaf = requestAnimationFrame(() => {
    layoutRaf = 0;
    applyHiDPIAndFit();
  });
}
applyHiDPIAndFit();
window.addEventListener('resize', scheduleLayout);
// Re-apply when the display's devicePixelRatio changes (drag between Retina/1×).
if (typeof window !== 'undefined' && window.matchMedia) {
  const watchDPR = () => {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onChange = () => {
      scheduleLayout();
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else if (mq.removeListener) mq.removeListener(onChange);
      setTimeout(watchDPR, 0);
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  };
  watchDPR();
}
function loadBrain(i) {
  brainIdx = i;
  world = new World([showcase ? champNet : pop.networks[i]]);
  currentBrain = showcase
    ? { genome: champGenome, network: champNet }
    : { genome: pop.genomes[i], network: pop.networks[i] };
}

// Close out the generation: gate metrics from raw-competence records, then evolve
// (showcase mode replays the champion instead of evolving).
function startNextGeneration() {
  const genBest = Math.max(...fitnesses);
  if (!showcase && genRecords.length) {
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
      gate.trippedGen = pop.generation;
    }
    console.log(
      'gen', pop.generation, 'best', genBest.toFixed(1),
      'AT', bestAT.toFixed(1), 'wave', bestWave, 'pts', bestPts,
      'medAT', medianAT.toFixed(1), 'gate', gate.count + '/15'
    );
  }
  genRecords = [];
  if (showcase) {
    const genAvg = fitnesses.reduce((s, v) => s + v, 0) / POP_SIZE;
    pop.history.push({ best: genBest, avg: genAvg }); // chart the champion replays
    pop.generation++;
  } else {
    pop.evolve(fitnesses);
  }
  fitnesses = new Array(POP_SIZE).fill(0);
  loadBrain(0);
}

// Bank the finished brain's fitness + novelty, then advance to the next brain
// or close out the generation (sets the real-time overlay).
function endEpisode() {
  const behavior = world.agentBehavior();
  fitnesses[brainIdx] = world.agents[0].fitness + archive.bonusFor(pop.generation) * archive.novelty(behavior);
  archive.add(behavior);
  genRecords.push({
    at: world.agents[0].stats.aliveTime,
    wave: world.wave,
    pts: world.agents[0].stats.rockPts,
  });
  if (!bestRun || fitnesses[brainIdx] > bestRun.fitness) {
    bestRun = { genome: currentBrain.genome, fitness: fitnesses[brainIdx], gen: pop.generation };
  }
  if (brainIdx + 1 >= POP_SIZE) {
    // Overlay shrinks with speed so fast-forward isn't gated by a 1s pause per
    // generation; 30ms floor keeps it visible without taxing 10000x runs.
    overlay = {
      text: `Gen ${pop.generation} complete — best ${Math.max(...fitnesses).toFixed(1)}`,
      remaining: Math.max(0.03, CONFIG.world.overlaySeconds / speed),
    };
  } else {
    loadBrain(brainIdx + 1);
  }
}

// Run up to `steps` sim steps within the frame budget. Brain transitions and
// generation ends are handled inline, so a frame is never wasted mid-budget
// (this is what lets high speeds actually reach the slider value).
function runSteps(steps) {
  const deadline = performance.now() + CONFIG.render.frameBudgetMs;
  let ran = 0;
  while (ran < steps) {
    if (world.done) {
      endEpisode();
      if (overlay) break; // generation complete; overlay runs in real time
      continue;
    }
    world.step(CONFIG.dt);
    ran++;
    if ((ran & 1023) === 0 && performance.now() >= deadline) break;
  }
  return ran;
}
function frame(now) {
  frameCount++;
  const realDt = Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;

  if (!paused) {
    effWall += realDt;
    if (overlay) {
      overlay.remaining -= realDt;
      if (overlay.remaining <= 0) {
        startNextGeneration();
        overlay = null;
      }
    } else {
      // Deterministic accumulator: one rAF frame = 1/60 wall-second by fiat, so
      // the step sequence (and thus a seeded run) is identical on every machine;
      // only wall-clock pacing shifts on non-60Hz displays (speedEff reports it).
      stepAcc += speed / 60;
      let steps = Math.floor(stepAcc / CONFIG.dt);
      if (steps > CONFIG.render.maxStepsPerFrame) {
        steps = CONFIG.render.maxStepsPerFrame;
        stepAcc = 0; // compute-bound: drop the backlog rather than lag forever
      }
      const ran = runSteps(steps);
      effSim += ran * CONFIG.dt;
      stepAcc -= ran * CONFIG.dt;
      if (ran < steps) stepAcc = 0; // budget cut us short; don't accrue debt
    }
  }

  // Above 16x, stepping dominates: redraw the arena every 4th frame only
  // (software rasterization of the canvas otherwise eats the frame budget).
  if (speed <= 16 || frameCount % 4 === 0) {
    renderArena(ctx, world, 0, showRays);
    if (overlay) renderOverlay(ctx, overlay.text);
  }

  panelTimer += realDt;
  if (panelTimer >= 1 / CONFIG.render.hudHz) {
    panelTimer = 0;
    renderHUD(hud, pop, world, brainIdx, {
      seed,
      gateCount: gate.count,
      gateTripped: gate.tripped,
      trippedGen: gate.trippedGen,
      showcase,
    });
    renderChart(chartCtx, pop);
    renderNetwork(netCtx, currentBrain.genome, currentBrain.network);
  }

  // FPS + measured effective sim speed in the tab title / next to the slider.
  fpsFrames++;
  fpsAccum += realDt;
  if (fpsAccum >= 1) {
    document.title = `Neuroevolution Asteroids — ${Math.round(fpsFrames / fpsAccum)}fps`;
    speedEff.textContent = effWall > 0
      ? `measured \u00d7${Math.round(effSim / effWall).toLocaleString()}`
      : '';
    fpsFrames = 0;
    fpsAccum = 0;
    effSim = 0;
    effWall = 0;
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- Controls ---
btnPause.addEventListener('click', () => {
  paused = !paused;
  btnPause.textContent = paused ? 'Resume' : 'Pause';
});

const speedSlider = document.getElementById('speedSlider');
const speedValue = document.getElementById('speedValue');

// Slider is logarithmic (0..4 -> 1x..10000x), snapped to 2 significant digits
// so the label always states the exact multiplier in effect.
function speedFromSlider(v) {
  const x = Math.pow(10, v);
  if (x < 10) return Math.round(x * 10) / 10;
  if (x < 100) return Math.round(x);
  if (x < 1000) return Math.round(x / 10) * 10;
  return Math.round(x / 100) * 100;
}

speedSlider.addEventListener('input', () => {
  speed = speedFromSlider(+speedSlider.value);
  speedValue.textContent = `\u00d7${speed.toLocaleString('en-US')}`;
});

// With ?seed= present Restart replays the pinned seed from gen 0; without it a
// new seed is rolled into the URL. Showcase mode restarts the champion replay.
document.getElementById('btnRestart').addEventListener('click', () => {
  resetInnovation();
  seed = urlSeed ?? newRandomSeed();
  setSeed(seed);
  if (!urlSeed) {
    history.replaceState(
      null,
      '',
      '?' + (champPath ? 'champ=' + encodeURIComponent(champPath) + '&' : '') + 'seed=' + seed
    );
  }
  pop = new Population(POP_SIZE); // rebuilt in showcase too: keeps the stream position identical to first load
  archive = new NoveltyArchive();
  fitnesses = new Array(POP_SIZE).fill(0);
  genRecords = [];
  bestRun = null;
  gate.bestAT = 0;
  gate.bestWave = 0;
  gate.bestPts = 0;
  gate.medians = [];
  gate.count = 0;
  gate.tripped = false;
  gate.trippedGen = 0;
  loadBrain(0);
  overlay = null;
  paused = false;
  btnPause.textContent = 'Pause';
});

const btnRays = document.getElementById('btnRays');
btnRays.addEventListener('click', () => {
  showRays = !showRays;
  btnRays.classList.toggle('active', showRays);
});

// Download the best genome of this run so far (banked fitness, incl. novelty).
document.getElementById('btnChamp').addEventListener('click', () => {
  if (!bestRun) return;
  const data = { ...bestRun.genome.toJSON(), seed, generation: bestRun.gen, fitness: bestRun.fitness };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `seed${seed}-g${bestRun.gen}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
