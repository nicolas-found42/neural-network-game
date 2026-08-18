// Single source of truth for every pinned constant (execution plan section "Pinned design").
export const CONFIG = {
  dt: 1 / 60, // fixed sim timestep

  arena: { width: 960, height: 600, background: '#0b0e14', starCount: 120, starAlpha: 0.5 },

  ship: {
    radius: 9,
    rotateSpeed: 3.2, // rad/s
    thrust: 140, // px/s^2
    damping: 0.6, // v *= max(0, 1 - damping*dt)
    maxSpeed: 320,
    hitboxFactor: 0.7, // dies if dist < asteroidR + radius*hitboxFactor
    spawnJitter: 80, // px around arena center
  },

  bullet: {
    speed: 420, // plus firing ship's velocity
    life: 1.1, // s
    radius: 2,
    noseOffset: 12, // spawn at ship pos + heading*noseOffset
    cooldown: 0.35, // s
    maxAlivePerShip: 4,
    recoil: 10, // px/s backward nudge per shot
  },

  asteroid: {
    sizes: {
      L: { r: 38, pts: 20, minSpeed: 20, maxSpeed: 45, child: 'M' },
      M: { r: 21, pts: 50, minSpeed: 35, maxSpeed: 65, child: 'S' },
      S: { r: 11, pts: 100, minSpeed: 55, maxSpeed: 95, child: null },
    },
    vertices: 10,
    jitterMin: 0.75,
    jitterMax: 1.25,
    spinMax: 1, // rad/s, uniform(-spinMax, spinMax), visual only
    initialCount: 5, // rocks in wave 1; later waves: ceil(prev * waveGrowth)
    initialMinDistFromShip: 150, // wave rocks spawn at least this far (toroidal) from the ship
    splitAngleMin: 20, // degrees off parent direction
    splitAngleMax: 70,
    splitImpulseFactor: 0.5, // fraction of child speed range added on top of inherited velocity
    speedCap: 160, // global asteroid speed cap (momentum inheritance compounds through splits)
    restitution: 1, // rock-rock elasticity (1 = perfectly elastic)
    waveGrowth: 1.25, // rocks per wave multiply by this when the field is cleared
  },

  sensors: {
    rayOffsetsDeg: [0, 40, -40, 80, -80, 120, -120, 160, -160], // index order is input order
    range: 500,
    velScale: 300,
    pressureNorm: 8, // proximity-pressure sensor normalization
  },

  nn: {
    // 0-8 rays (toroidal), 9 vx, 10 vy, 11 bias, 12 threatBearing, 13 threatCloseness,
    // 14 threatClosing, 15 guns, 16 threatLateral, 17 threat2Closeness, 18 threatSize,
    // 19 proximityPressure, 20 memory (fed back from output 25 each step).
    // Local ship-crowding was removed with the shared-fleet -> solo evaluation switch.
    inputs: 21,
    outputs: 5,
    outputIds: [21, 22, 23, 24, 25], // left, right, thrust, fire, memory
    actionThreshold: 0.5,
    firstHiddenNodeId: 26,
  },

  neat: {
    popSize: 100,
    weightInitMin: -1,
    weightInitMax: 1,
    addConnectionRate: 0.1, // contingency: raised from 0.06 after learning gate tripped
    addConnectionAttempts: 10,
    addNodeRate: 0.02,
    weightPerturbRate: 0.08,
    weightPerturbSigma: 0.4, // contingency: raised from 0.25 after learning gate tripped
    weightReplaceRate: 0.01,
    weightReplaceMin: -1.5,
    weightReplaceMax: 1.5,
    weightMin: -4,
    weightMax: 4,
    distanceC1: 1.0, // excess
    distanceC2: 1.0, // disjoint
    distanceC3: 0.4, // mean matching weight difference
    deltaTargetInit: 3.0,
    deltaStep: 0.15,
    deltaMin: 1,
    deltaMax: 6,
    speciesCountMin: 8,
    speciesCountMax: 12,
    stagnationLimit: 15,
    survivalFraction: 0.5, // drop bottom 50%
    championMinSize: 5,
    crossoverRate: 0.75,
  },

  world: {
    waveTimeLimit: 60, // sim seconds per wave; clearing a wave resets this clock
    episodeHardCap: 300, // absolute sim seconds per brain, bounds wave chaining
    overlaySeconds: 1.0,
  },

  fitness: {
    alivePerSecond: 10,
    bulletCost: 1,
    // --- Exploration shaping (anti-degenerate-strategy), research-grounded: ---
    // Movement reward: speed-fraction per second (Space Hammer movePoints;
    // arXiv:2311.02283 objective decomposition). Fixes "thrust is punished".
    moveRate: 4,
    // Action-usage entropy bonus, max at uniform usage of all 4 controls
    // (arXiv:1006.4959 sensorimotor entropy; arXiv:2608.12534 entropy-augmented fitness).
    actionEntropyBonus: 300,
    // Behavior-descriptor novelty bonus with generation decay to a floor
    // (arXiv:1902.03142 action novelty; arXiv:2209.03618 adaptive explore/exploit).
    noveltyBonus: 400,
    noveltyDecayGens: 60, // linear decay horizon, then floor
    noveltyFloorFrac: 0.2,
    archiveSize: 400,
    noveltyK: 15,
  },

  render: {
    hudHz: 10,
    chart: { width: 300, height: 110, bestColor: '#39d0ff', avgColor: '#ffb347', maxGens: 120 },
    network: {
      width: 280, height: 420,
      inX: 40, hiddenXMin: 140, hiddenXMax: 200, outX: 250, nodeRadius: 5,
    },
    speedMin: 1,
    speedMax: 10000, // slider top end; 10000x at 60fps = ~10k steps/frame
    maxStepsPerFrame: 20000, // safety cap; 20ms budget is the real guard. Solo step ~0.0001ms.
    frameBudgetMs: 20,
  },
};
