// Adapter: browser rAF loop + DOM/controls over the EvolutionRunner deep module.
// Rendering is delegated to ArenaRenderer (deep façade).
import { CONFIG } from './config.js';
import { Genome, Network, InnovationTracker, resetInnovation } from './neat.js';
import { ArenaRenderer } from './render.js';
import { createRNG, setSeed } from './rng.js';
import { EvolutionRunner } from './evolution.js';

const arena = document.getElementById('arena');
const hud = document.getElementById('hud');
const chartCanvas = document.getElementById('chart');
const netCanvas = document.getElementById('net');
const btnPause = document.getElementById('btnPause');

// --- Seed & URL ownership: ?seed=N pins the run (deterministic replay from gen 0),
// ?champ=<repo-relative path> showcases a champion genome instead of evolving.
const params = new URLSearchParams(location.search);
const urlSeed = params.has('seed') ? (Number.parseInt(params.get('seed'), 10) >>> 0) : null;
const champPath = params.get('champ');
// Seed choice is not part of the run: pristine Math.random, never the seeded stream.
const newRandomSeed = () => Math.floor(Math.random() * 0x7FFFFFFF);

const POP_SIZE = CONFIG.neat.popSize;
let showcase = false;
let champGenome = null;
let champNet = null;

let seed = urlSeed ?? newRandomSeed();
// Legacy global stream (kept for any module still reading global rand) + explicit seam.
setSeed(seed);
let rng = createRNG(seed);
let tracker = new InnovationTracker();

let initialOverlay = null;
if (champPath) {
  try {
    champGenome = Genome.fromJSON(await (await fetch(champPath)).json());
    champNet = Network.fromGenome(champGenome);
    showcase = true;
  } catch (e) {
    console.error('champion failed to load', e);
    initialOverlay = { text: 'champion failed to load — fresh run', remaining: 3 };
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

let runner = new EvolutionRunner({ rng, tracker, seed, champGenome, champNet, showcase });
if (initialOverlay) runner.overlay = initialOverlay;

let paused = false;
let speed = 100; // sim seconds per wall second, 1..CONFIG.render.speedMax
let showRays = false;
let lastFrameTime = performance.now();
let fpsFrames = 0;
let fpsAccum = 0;
let effSim = 0; // sim seconds stepped in the current measurement window
let effWall = 0; // wall seconds in the current measurement window
const speedEff = document.getElementById('speedEff');

// Rendering deep module: owns canvas, HiDPI, stars, HUD, chart, net.
const renderer = new ArenaRenderer({ arena, hud, chart: chartCanvas, net: netCanvas });
renderer.attachListeners();

function frame(now) {
  const realDt = Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;

  if (!paused) {
    effWall += realDt;
    const { ran } = runner.tick(realDt, speed);
    effSim += ran * CONFIG.dt;
  }

  renderer.frame({
    world: runner.world,
    pop: runner.pop,
    brainIdx: runner.brainIdx,
    showRays,
    overlay: runner.overlay,
    info: {
      seed,
      gateCount: runner.gate.count,
      gateTripped: runner.gate.tripped,
      trippedGen: runner.gate.trippedGen,
      showcase,
    },
    currentBrain: runner.currentBrain,
    realDt,
    speed,
  });

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
  rng = createRNG(seed);
  tracker = new InnovationTracker();
  if (!urlSeed) {
    history.replaceState(
      null,
      '',
      '?' + (champPath ? 'champ=' + encodeURIComponent(champPath) + '&' : '') + 'seed=' + seed
    );
  }
  runner = new EvolutionRunner({ rng, tracker, seed, champGenome, champNet, showcase });
  paused = false;
  btnPause.textContent = 'Pause';
  // Reset adapter-local timers so eff measurement restarts cleanly.
  lastFrameTime = performance.now();
  fpsFrames = 0;
  fpsAccum = 0;
  effSim = 0;
  effWall = 0;
  renderer.frameCount = 0;
  renderer.panelTimer = 0;
});

const btnRays = document.getElementById('btnRays');
btnRays.addEventListener('click', () => {
  showRays = !showRays;
  btnRays.classList.toggle('active', showRays);
});

// Download the best genome of this run so far (banked fitness, incl. novelty).
document.getElementById('btnChamp').addEventListener('click', () => {
  if (!runner.bestRun) return;
  const data = { ...runner.bestRun.genome.toJSON(), seed, generation: runner.bestRun.gen, fitness: runner.bestRun.fitness };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `seed${seed}-g${runner.bestRun.gen}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
