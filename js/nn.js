// =====================================================
// Neural-net integration (ONNX via onnxruntime-web).
// Loads cell_policy.onnx on demand; gracefully no-ops
// when unavailable so the rest of the game works.
// =====================================================
import { state } from './state.js';
import { NN_OWNERS, NN_MODEL_URL, NN_N, NN_F, NN_HIDDEN, FLEET_SPEED } from './config.js';
import { dist } from './util.js';

const NN_OWNER_IDX = { player: 0, red: 1, green: 2, amber: 3, neutral: 4 };

let nnSession = null;
let nnReady = false;
const nnHidden = {};
const nnLastAction = {};
const nnPending = {};

export function isNNReady() { return nnReady; }
export function nnActionFor(owner) { return nnLastAction[owner] || null; }

export function nnResetGame() {
  for (const o of NN_OWNERS) {
    nnHidden[o] = new Float32Array(NN_HIDDEN);
    nnLastAction[o] = null;
    nnPending[o] = false;
  }
}

/** The trained ONNX policy is a local-dev nicety; the SHIPPED opponent is the
 *  heuristic v3 AI, which plays fine without any model. So we only attempt the
 *  NN load on localhost. Off localhost (e.g. inside the CrazyGames iframe) the
 *  badge stays hidden and nothing is loaded — no "model not loaded" error text
 *  and no console noise ever reaches a real player. */
function isLocalhost() {
  const h = (typeof location !== 'undefined' && location.hostname) || '';
  return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

export async function nnLoad() {
  const badge = document.getElementById('nn-badge');
  // Hidden by default in the HTML; only a SUCCESSFUL load reveals it.
  if (!isLocalhost() || typeof ort === 'undefined') return;
  ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/';
  ort.env.wasm.numThreads = 1;
  try {
    nnSession = await ort.InferenceSession.create(NN_MODEL_URL, { executionProviders: ['wasm'] });
    nnReady = true;
    if (badge) { badge.classList.remove('loading'); badge.style.display = 'block'; badge.textContent = 'NPC: Crimson is the trained policy'; }
  } catch (e) {
    // localhost-dev only (skipped off localhost), so this is never seen by a
    // real player — a warn keeps the dev console tidy without an error.
    if (badge) badge.style.display = 'none';
    console.warn('NPC model not loaded (heuristic AI in use):', e && e.message ? e.message : e);
  }
}

/** Build observation tensor for `meOwner`. Matches training cell_env.observe(). */
function nnBuildObs(meOwner) {
  const N = NN_N, F = NN_F;
  const { nodes, adj, fleets } = state;
  const nf = new Float32Array(N * F);
  const am = new Float32Array(N * N);
  const valid = new Uint8Array(N * N);
  const meIdx = NN_OWNER_IDX[meOwner];
  const realCount = Math.min(nodes.length, N);

  for (let i = 0; i < realCount; i++) {
    const n = nodes[i];
    const oIdx = NN_OWNER_IDX[n.owner];
    const col = oIdx === 4 ? 4 : ((oIdx - meIdx + 4) % 4);
    nf[i * F + col] = 1.0;
    const cap = Math.max(1, n.capacity);
    const sat = n.units / cap;
    nf[i * F + 5] = sat;
    nf[i * F + 6] = Math.max(0, Math.min(1, 1 - sat));
    nf[i * F + 7] = sat > 0.95 ? 1 : 0;
    nf[i * F + 8] = n.units / 100;
    nf[i * F + 9] = n.capacity / 100;
    nf[i * F + 10] = n.regenRate / 2;
    nf[i * F + 11] = n.size / 60;
    nf[i * F + 17] = 1.0;     // friend ETA default = far
    nf[i * F + 18] = 1.0;     // hostile ETA default
  }

  for (let i = 0; i < realCount; i++) {
    let nF = 0, nE = 0, nNu = 0;
    for (const j of adj.get(i)) {
      if (j >= N) continue;
      am[i * N + j] = 1.0;
      const jIdx = NN_OWNER_IDX[nodes[j].owner];
      if (jIdx === meIdx) nF++;
      else if (jIdx === 4) nNu++;
      else nE++;
    }
    nf[i * F + 12] = nF / 8;
    nf[i * F + 13] = nE / 8;
    nf[i * F + 14] = nNu / 8;
  }

  for (const f of fleets) {
    if (!f.path) continue;
    const tgt = f.path[f.path.length - 1];
    if (tgt >= N) continue;
    let remaining = 0;
    if (f.segIdx < f.path.length - 1) {
      const a = nodes[f.path[f.segIdx]], b = nodes[f.path[f.segIdx + 1]];
      remaining += Math.max(0, dist(a, b) - f.segTraveled);
      for (let k = f.segIdx + 1; k < f.path.length - 1; k++)
        remaining += dist(nodes[f.path[k]], nodes[f.path[k + 1]]);
    }
    const eta = remaining / FLEET_SPEED;
    const etaNorm = Math.min(eta, 30) / 30;
    if (f.owner === meOwner) {
      nf[tgt * F + 15] += f.units / 100;
      if (etaNorm < nf[tgt * F + 17]) nf[tgt * F + 17] = etaNorm;
      if (eta <= 5) nf[tgt * F + 19] += f.units / 100;
    } else {
      nf[tgt * F + 16] += f.units / 100;
      if (etaNorm < nf[tgt * F + 18]) nf[tgt * F + 18] = etaNorm;
      if (eta <= 5) nf[tgt * F + 20] += f.units / 100;
    }
  }

  for (let src = 0; src < realCount; src++) {
    if (nodes[src].owner !== meOwner || nodes[src].units < 2) continue;
    for (const dst of adj.get(src)) {
      if (dst >= N) continue;
      valid[src * N + dst] = 1;
    }
  }
  return { nf, am, valid };
}

/** Async: run inference, store sampled action into nnLastAction[meOwner]. */
export async function nnDecide(meOwner) {
  if (!nnReady || nnPending[meOwner]) return;
  nnPending[meOwner] = true;
  try {
    const obs = nnBuildObs(meOwner);
    const feeds = {
      nf: new ort.Tensor('float32', obs.nf, [1, NN_N, NN_F]),
      am: new ort.Tensor('float32', obs.am, [1, NN_N, NN_N]),
      hidden_in: new ort.Tensor('float32', nnHidden[meOwner], [1, NN_HIDDEN]),
    };
    const res = await nnSession.run(feeds);
    nnHidden[meOwner] = new Float32Array(res.hidden_out.data);
    const el = res.edge_logits.data;
    const nop = res.no_op_logit.data[0];
    const NA = NN_N * NN_N + 1;
    let maxL = nop;
    for (let i = 0; i < NN_N * NN_N; i++) {
      const v = obs.valid[i] ? el[i] : -1e9;
      if (v > maxL) maxL = v;
    }
    const exps = new Float64Array(NA);
    let sum = 0;
    for (let i = 0; i < NN_N * NN_N; i++) {
      exps[i] = obs.valid[i] ? Math.exp(el[i] - maxL) : 0;
      sum += exps[i];
    }
    exps[NN_N * NN_N] = Math.exp(nop - maxL);
    sum += exps[NN_N * NN_N];
    let r = Math.random() * sum, pick = NA - 1;
    for (let i = 0; i < NA; i++) {
      r -= exps[i];
      if (r <= 0) { pick = i; break; }
    }
    nnLastAction[meOwner] = (pick === NN_N * NN_N) ? null
      : { src: Math.floor(pick / NN_N), dst: pick % NN_N };
  } catch (e) {
    console.error('NPC inference:', e);
    nnLastAction[meOwner] = null;
  } finally {
    nnPending[meOwner] = false;
  }
}
