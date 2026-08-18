// Owns Population + the solo evaluation loop (brains 0..99, one World each); rAF loop
// with log speed slider (1x..10000x)/pause; generation lifecycle; controls.
import { CONFIG } from './config.js';
import { World } from './game.js';
import { resetInnovation } from './neat.js';
import { Population, NoveltyArchive } from './population.js';
import { renderArena, renderOverlay, renderHUD, renderChart, renderNetwork } from './render.js';

const arena = document.getElementById('arena');
const hud = document.getElementById('hud');
const chartCtx = document.getElementById('chart').getContext('2d');
const netCtx = document.getElementById('net').getContext('2d');
const ctx = arena.getContext('2d');
const btnPause = document.getElementById('btnPause');

const POP_SIZE = CONFIG.neat.popSize;
let pop = new Population(POP_SIZE);
let archive = new NoveltyArchive();
let brainIdx = 0; // which brain of the current generation is under evaluation
let fitnesses = new Array(POP_SIZE).fill(0);
let world = new World([pop.networks[0]]); // solo: one brain per World
let currentBrain = { genome: pop.genomes[0], network: pop.networks[0] };
let paused = false;
let speed = 1; // sim seconds per wall second, 1..CONFIG.render.speedMax
let overlay = null; // { text, remaining }
let showRays = false;
let lastFrameTime = performance.now();
let panelTimer = 0;
let frameCount = 0;
let fpsFrames = 0;
let fpsAccum = 0;
let simDebt = 0; // sim seconds owed (debt accumulator for the speed slider)
let effSim = 0; // sim seconds stepped in the current measurement window
let effWall = 0; // wall seconds in the current measurement window
const speedEff = document.getElementById('speedEff');

// CSS-scale arena to fit the window, aspect preserved.
function fitArena() {
  const wrap = document.getElementById('arenaWrap');
  const scale = Math.min(
    wrap.clientWidth / CONFIG.arena.width,
    wrap.clientHeight / CONFIG.arena.height
  );
  arena.style.width = Math.floor(CONFIG.arena.width * scale) + 'px';
  arena.style.height = Math.floor(CONFIG.arena.height * scale) + 'px';
}
window.addEventListener('resize', fitArena);
fitArena();
function loadBrain(i) {
  brainIdx = i;
  world = new World([pop.networks[i]]);
  currentBrain = { genome: pop.genomes[i], network: pop.networks[i] };
}

function startNextGeneration() {
  pop.evolve(fitnesses);
  fitnesses = new Array(POP_SIZE).fill(0);
  loadBrain(0);
}

// Bank the finished brain's fitness + novelty, then advance to the next brain
// or close out the generation (sets the real-time overlay).
function endEpisode() {
  const behavior = world.agentBehavior();
  fitnesses[brainIdx] = world.agents[0].fitness + archive.bonusFor(pop.generation) * archive.novelty(behavior);
  archive.add(behavior);
  if (brainIdx + 1 >= POP_SIZE) {
    const genBest = Math.max(...fitnesses);
    // Overlay shrinks with speed so fast-forward isn't gated by a 1s pause per
    // generation; 30ms floor keeps it visible without taxing 10000x runs.
    overlay = {
      text: `Gen ${pop.generation} complete — best ${genBest.toFixed(1)}`,
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
      // Debt accumulator: sim seconds owed, so speed tracks real time at any
      // frame rate (a dropped frame catches up next frame, bounded by the cap).
      simDebt += realDt * speed;
      let steps = Math.floor(simDebt / CONFIG.dt);
      if (steps > CONFIG.render.maxStepsPerFrame) {
        steps = CONFIG.render.maxStepsPerFrame;
        simDebt = 0; // compute-bound: drop the backlog rather than lag forever
      }
      const ran = runSteps(steps);
      effSim += ran * CONFIG.dt;
      simDebt -= ran * CONFIG.dt;
      if (ran < steps) simDebt = 0; // budget cut us short; don't accrue debt
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
    renderHUD(hud, pop, world, brainIdx);
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

document.getElementById('btnRestart').addEventListener('click', () => {
  resetInnovation();
  pop = new Population(POP_SIZE);
  archive = new NoveltyArchive();
  fitnesses = new Array(POP_SIZE).fill(0);
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
