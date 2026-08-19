// NEAT: genomes, structural/weight mutations, owned innovation tracker, feedforward phenotype.
import { CONFIG } from './config.js';
import { rand, randn, rng, randInt, defaultRNG } from './rng.js';

const N = CONFIG.neat;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---- Innovation tracker: owned per-Population (deep module seam), with a
// legacy global singleton for backward compat where no tracker is threaded.
export class InnovationTracker {
  constructor(startId = CONFIG.nn.firstHiddenNodeId) {
    this.nextId = startId;
    this.innovOf = new Map(); // "from:to" -> innov
  }
  getInnovation(from, to) {
    const key = from + ':' + to;
    let innov = this.innovOf.get(key);
    if (innov === undefined) {
      innov = this.nextId++;
      this.innovOf.set(key, innov);
    }
    return innov;
  }
  newNodeId() {
    return this.nextId++;
  }
  reset() {
    this.nextId = CONFIG.nn.firstHiddenNodeId;
    this.innovOf.clear();
  }
}

// Legacy singleton — kept so existing callers (verify, probes, main) that
// call getInnovation/newNodeId/resetInnovation without a tracker still work.
// New code should use Population.tracker or pass a tracker explicitly.
const defaultTracker = new InnovationTracker();
export const defaultInnovationTracker = defaultTracker;

export function getInnovation(from, to) {
  return defaultTracker.getInnovation(from, to);
}

export function newNodeId() {
  return defaultTracker.newNodeId();
}

export function resetInnovation() {
  defaultTracker.reset();
}

function resolveRNG(rngObj) {
  return rngObj ?? defaultRNG;
}
function resolveTracker(tracker) {
  return tracker ?? defaultTracker;
}

export class Genome {
  constructor(rngObj = null, tracker = null) {
    const _rng = resolveRNG(rngObj);
    const _tracker = resolveTracker(tracker);
    // Initial genome: all 105 input->output connections, random weights, no hidden nodes.
    this.nodes = new Map();
    this.connections = new Map();
    for (let i = 0; i < CONFIG.nn.inputs; i++) this.nodes.set(i, { type: 'input' });
    for (const o of CONFIG.nn.outputIds) this.nodes.set(o, { type: 'output' });
    for (let i = 0; i < CONFIG.nn.inputs; i++) {
      for (const o of CONFIG.nn.outputIds) {
        this.connections.set(_tracker.getInnovation(i, o), {
          in: i,
          out: o,
          w: _rng.rand(N.weightInitMin, N.weightInitMax),
          enabled: true,
        });
      }
    }
  }

  static blank() {
    // Construct properly (private methods need the constructor's brand), then empty it.
    const g = new Genome();
    g.nodes.clear();
    g.connections.clear();
    return g;
  }

  copy() {
    const g = Genome.blank();
    for (const [id, n] of this.nodes) g.nodes.set(id, { type: n.type });
    for (const [innov, c] of this.connections) g.connections.set(innov, { ...c });
    return g;
  }

  // Champion export: plain arrays so the JSON stays small and diffable.
  toJSON() {
    return {
      version: 1,
      nodes: [...this.nodes].map(([id, n]) => [id, n.type]),
      connections: [...this.connections].map(([innov, c]) => [innov, c.in, c.out, c.w, c.enabled]),
    };
  }

  static fromJSON(obj) {
    const g = Genome.blank();
    for (const [id, type] of obj.nodes) g.nodes.set(id, { type });
    for (const [innov, inId, outId, w, enabled] of obj.connections) {
      g.connections.set(innov, { in: inId, out: outId, w, enabled });
    }
    const count = (t) => [...g.nodes.values()].filter((n) => n.type === t).length;
    if (count('input') !== CONFIG.nn.inputs || count('output') !== CONFIG.nn.outputIds.length) {
      throw new Error('champion: expected 21 inputs / 5 outputs');
    }
    return g;
  }

  mutateWeights(rngObj = null) {
    const _rng = resolveRNG(rngObj);
    for (const c of this.connections.values()) {
      if (_rng.rng() < N.weightPerturbRate) {
        c.w = clamp(c.w + _rng.randn() * N.weightPerturbSigma, N.weightMin, N.weightMax);
      }
      if (_rng.rng() < N.weightReplaceRate) {
        c.w = _rng.rand(N.weightReplaceMin, N.weightReplaceMax);
      }
    }
  }

  #hasPath(from, to) {
    // DFS over enabled connections: is there a path from -> to?
    const stack = [from];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const c of this.connections.values()) {
        if (c.enabled && c.in === id) stack.push(c.out);
      }
    }
    return false;
  }

  mutateAddConnection(rngObj = null, tracker = null) {
    const _rng = resolveRNG(rngObj);
    const _tracker = resolveTracker(tracker);
    const ids = [...this.nodes.keys()];
    const aPool = ids.filter((id) => this.nodes.get(id).type !== 'output'); // input | hidden
    const bPool = ids.filter((id) => this.nodes.get(id).type !== 'input'); // hidden | output
    if (!aPool.length || !bPool.length) return;
    for (let attempt = 0; attempt < N.addConnectionAttempts; attempt++) {
      const a = aPool[_rng.randInt(aPool.length)];
      const b = bPool[_rng.randInt(bPool.length)];
      if (a === b) continue;
      let connected = false;
      for (const c of this.connections.values()) {
        if (c.in === a && c.out === b) {
          connected = true;
          break;
        }
      }
      if (connected) continue; // pair already present (enabled or disabled)
      if (this.#hasPath(b, a)) continue; // would create a cycle
      this.connections.set(_tracker.getInnovation(a, b), {
        in: a,
        out: b,
        w: _rng.rand(N.weightInitMin, N.weightInitMax),
        enabled: true,
      });
      return;
    }
  }

  mutateAddNode(rngObj = null, tracker = null) {
    const _rng = resolveRNG(rngObj);
    const _tracker = resolveTracker(tracker);
    const enabled = [...this.connections.values()].filter((c) => c.enabled);
    if (!enabled.length) return;
    const c = enabled[_rng.randInt(enabled.length)];
    c.enabled = false;
    const id = _tracker.newNodeId();
    this.nodes.set(id, { type: 'hidden' });
    this.connections.set(_tracker.getInnovation(c.in, id), { in: c.in, out: id, w: 1, enabled: true });
    this.connections.set(_tracker.getInnovation(id, c.out), { in: id, out: c.out, w: c.w, enabled: true });
  }

  // aFitter: true = a fitter, false = b fitter, null = equal fitness (take all genes from both).
  static crossover(a, b, aFitter, rngObj = null) {
    const _rng = resolveRNG(rngObj);
    const child = Genome.blank();
    // Nodes: fixed input/output set plus every hidden endpoint referenced by a carried
    // gene. Unioning parent node sets would create connection-less orphan nodes.
    for (let i = 0; i < CONFIG.nn.inputs; i++) child.nodes.set(i, { type: 'input' });
    for (const o of CONFIG.nn.outputIds) child.nodes.set(o, { type: 'output' });
    const nodeType = (id) =>
      id < CONFIG.nn.inputs
        ? 'input'
        : CONFIG.nn.outputIds.includes(id)
          ? 'output'
          : 'hidden';
    const addEndpoint = (id) => {
      if (!child.nodes.has(id)) child.nodes.set(id, { type: nodeType(id) });
    };
    const equal = aFitter === null;
    for (const [innov, ca] of a.connections) {
      const cb = b.connections.get(innov);
      if (cb) {
        const pick = equal
          ? (_rng.rng() < 0.5 ? ca : cb)
          : (aFitter ? ca : cb);
        child.connections.set(innov, { ...pick });
      } else if (aFitter === true || equal) {
        child.connections.set(innov, { ...ca });
      }
    }
    if (aFitter === false || equal) {
      for (const [innov, cb] of b.connections) {
        if (!a.connections.has(innov)) child.connections.set(innov, { ...cb });
      }
    }
    for (const c of child.connections.values()) {
      addEndpoint(c.in);
      addEndpoint(c.out);
    }
    return child;
  }
}

// delta = (c1*E + c2*D)/N + c3*Wbar, over enabled matching connections.
export function genomeDistance(a, b) {
  let maxA = -Infinity;
  let maxB = -Infinity;
  for (const k of a.connections.keys()) if (k > maxA) maxA = k;
  for (const k of b.connections.keys()) if (k > maxB) maxB = k;
  let excess = 0, disjoint = 0, wSum = 0, wCount = 0;
  for (const [innov, ca] of a.connections) {
    const cb = b.connections.get(innov);
    if (cb) {
      if (ca.enabled && cb.enabled) {
        wSum += Math.abs(ca.w - cb.w);
        wCount++;
      }
    } else if (innov > maxB) excess++;
    else disjoint++;
  }
  for (const innov of b.connections.keys()) {
    if (!a.connections.has(innov)) {
      if (innov > maxA) excess++;
      else disjoint++;
    }
  }
  const size = Math.max(a.connections.size, b.connections.size, 1);
  const wBar = wCount ? wSum / wCount : 0;
  return (N.distanceC1 * excess + N.distanceC2 * disjoint) / size + N.distanceC3 * wBar;
}

export class Network {
  static fromGenome(genome) {
    const net = new Network();
    const enabled = [...genome.connections.values()].filter((c) => c.enabled);

    // Kahn topological order over enabled connections (cached).
    const inDeg = new Map();
    const adj = new Map();
    for (const id of genome.nodes.keys()) {
      inDeg.set(id, 0);
      adj.set(id, []);
    }
    for (const c of enabled) {
      if (!adj.has(c.in) || !adj.has(c.out)) continue;
      adj.get(c.in).push(c.out);
      inDeg.set(c.out, inDeg.get(c.out) + 1);
    }
    const queue = [];
    for (const [id, d] of inDeg) if (d === 0) queue.push(id);
    const order = [];
    const ordered = new Set();
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      ordered.add(id);
      for (const out of adj.get(id)) {
        const d = inDeg.get(out) - 1;
        inDeg.set(out, d);
        if (d === 0) queue.push(out);
      }
    }
    for (const id of genome.nodes.keys()) if (!ordered.has(id)) order.push(id); // cycle safety

    net.order = order;
    net.isInput = new Set(
      [...genome.nodes.entries()].filter(([, n]) => n.type === 'input').map(([id]) => id)
    );
    net.outputIds = CONFIG.nn.outputIds;
    net.inConns = new Map(); // out id -> [{in, w}]
    for (const c of enabled) {
      let list = net.inConns.get(c.out);
      if (!list) net.inConns.set(c.out, (list = []));
      list.push({ in: c.in, w: c.w });
    }
    net.lastActivations = new Map();
    return net;
  }

  // inputs: array indexed by input node id (0..11). Returns [left, right, thrust, fire].
  activate(inputs) {
    const vals = this.lastActivations;
    vals.clear();
    for (let i = 0; i < inputs.length; i++) vals.set(i, inputs[i]);
    for (const id of this.order) {
      if (this.isInput.has(id)) continue;
      let sum = 0;
      const inc = this.inConns.get(id);
      if (inc) {
        for (const c of inc) {
          const v = vals.get(c.in);
          if (v !== undefined) sum += c.w * v;
        }
      }
      vals.set(id, Math.tanh(sum));
    }
    return this.outputIds.map((id) => vals.get(id) ?? 0);
  }
}
