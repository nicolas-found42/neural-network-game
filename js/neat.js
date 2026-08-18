// NEAT: genomes, structural/weight mutations, shared innovation tracker, feedforward phenotype.
import { CONFIG } from './config.js';

const N = CONFIG.neat;

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const randn = () => {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// ---- Innovation tracker: one shared counter; hidden node ids come from the same
// counter (starting at 16). Persists across generations; reset on Restart.
let nextId = CONFIG.nn.firstHiddenNodeId;
const innovOf = new Map(); // "from:to" -> innov

export function getInnovation(from, to) {
  const key = from + ':' + to;
  let innov = innovOf.get(key);
  if (innov === undefined) {
    innov = nextId++;
    innovOf.set(key, innov);
  }
  return innov;
}

export function newNodeId() {
  return nextId++;
}

export function resetInnovation() {
  nextId = CONFIG.nn.firstHiddenNodeId;
  innovOf.clear();
}

export class Genome {
  constructor() {
    // Initial genome: all 48 input->output connections, random weights, no hidden nodes.
    this.nodes = new Map();
    this.connections = new Map();
    for (let i = 0; i < CONFIG.nn.inputs; i++) this.nodes.set(i, { type: 'input' });
    for (const o of CONFIG.nn.outputIds) this.nodes.set(o, { type: 'output' });
    for (let i = 0; i < CONFIG.nn.inputs; i++) {
      for (const o of CONFIG.nn.outputIds) {
        this.connections.set(getInnovation(i, o), {
          in: i,
          out: o,
          w: rand(N.weightInitMin, N.weightInitMax),
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

  mutateWeights() {
    for (const c of this.connections.values()) {
      if (Math.random() < N.weightPerturbRate) {
        c.w = clamp(c.w + randn() * N.weightPerturbSigma, N.weightMin, N.weightMax);
      }
      if (Math.random() < N.weightReplaceRate) {
        c.w = rand(N.weightReplaceMin, N.weightReplaceMax);
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

  mutateAddConnection() {
    const ids = [...this.nodes.keys()];
    const aPool = ids.filter((id) => this.nodes.get(id).type !== 'output'); // input | hidden
    const bPool = ids.filter((id) => this.nodes.get(id).type !== 'input'); // hidden | output
    if (!aPool.length || !bPool.length) return;
    for (let attempt = 0; attempt < N.addConnectionAttempts; attempt++) {
      const a = aPool[Math.floor(Math.random() * aPool.length)];
      const b = bPool[Math.floor(Math.random() * bPool.length)];
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
      this.connections.set(getInnovation(a, b), {
        in: a,
        out: b,
        w: rand(N.weightInitMin, N.weightInitMax),
        enabled: true,
      });
      return;
    }
  }

  mutateAddNode() {
    const enabled = [...this.connections.values()].filter((c) => c.enabled);
    if (!enabled.length) return;
    const c = enabled[Math.floor(Math.random() * enabled.length)];
    c.enabled = false;
    const id = newNodeId();
    this.nodes.set(id, { type: 'hidden' });
    this.connections.set(getInnovation(c.in, id), { in: c.in, out: id, w: 1, enabled: true });
    this.connections.set(getInnovation(id, c.out), { in: id, out: c.out, w: c.w, enabled: true });
  }

  // aFitter: true = a fitter, false = b fitter, null = equal fitness (take all genes from both).
  static crossover(a, b, aFitter) {
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
          ? (Math.random() < 0.5 ? ca : cb)
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
