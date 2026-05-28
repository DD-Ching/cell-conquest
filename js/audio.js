// =====================================================
// Sound engine — synthesized by default, swappable later.
//
// MAIN-THREAD ONLY. The Web Audio graph lives here; the sim (combat / drones /
// fleets) and the loop call the exported event hooks. In a Worker context
// `initAudio()` is never called, so `actx` stays null and every hook is a cheap
// no-op — importing this module anywhere is side-effect-free until init.
//
// Design mirrors the sprite asset pattern (assets/manifest.json + fallback):
//   - Every sound has a PROGRAMMATIC default (oscillator / filtered noise) so
//     the game always has audio with ZERO files shipped.
//   - assets/sfx-manifest.json lists names whose custom uploads should override
//     the synth (default []). When a name is listed we fetch assets/sfx/<name>.*
//     and play the decoded buffer instead. This is the "upload channel" left
//     open for later — drop a file in, list its name, done. Nothing to wire.
//
// Spatialisation (the player's spec): a sound at world (x,y) is placed by the
// CURRENT VIEW — pan left/right by its horizontal screen position, louder the
// nearer it is to screen-centre, quieter toward the edges; the drone buzz only
// becomes audible once zoomed in close. See spatial().
//
// Browser autoplay policy: an AudioContext can't start before a user gesture,
// so the context is created/resumed on the first pointerdown / keydown.
// =====================================================
import { state } from './state.js';

const MASTER_VOL      = 0.5;
const DRONE_BUZZ_VOL  = 0.30;
const ZOOM_AUDIBLE_MIN = 1.2;   // below this zoom, drones are silent
const ZOOM_AUDIBLE_FULL = 2.0;  // at/above this zoom, drone buzz is at full strength

let actx = null;            // AudioContext (null until first gesture / in a Worker)
let master = null;          // master GainNode (mute = ramp to 0)
let muted = false;
let buzz = null;            // persistent drone-swarm voice { gain, pan }
let noiseBuf = null;        // shared white-noise buffer for gunfire / explosions
const customBuffers = {};   // name -> decoded AudioBuffer (uploaded override)
let frameExplosions = 0;    // per-frame explosion cap (reset each updateAudio)

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

// ---- Setup (lazy, gesture-gated) ----
export function initAudio() {
  const kick = () => {
    if (!actx) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        actx = new AC();
        master = actx.createGain();
        master.gain.value = muted ? 0 : MASTER_VOL;
        master.connect(actx.destination);
        noiseBuf = makeNoise(0.6);
        setupBuzz();
        loadCustomManifest();          // async — fills customBuffers, overrides synth
      } catch (e) { actx = null; }
    }
    if (actx && actx.state === 'suspended') actx.resume();
  };
  addEventListener('pointerdown', kick);
  addEventListener('keydown', kick);
}

function makeNoise(seconds) {
  const n = Math.floor(actx.sampleRate * seconds);
  const buf = actx.createBuffer(1, n, actx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// Persistent drone-swarm voice: two detuned saws through a lowpass → gain →
// panner → master. Always running; updateAudio just drives gain + pan so the
// swarm hum swells/fades and pans with the view (no per-drone voices = cheap).
function setupBuzz() {
  const o1 = actx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 78;
  const o2 = actx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 117; o2.detune.value = 8;
  const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 4;
  const gain = actx.createGain(); gain.gain.value = 0;
  const pan = actx.createStereoPanner ? actx.createStereoPanner() : null;
  o1.connect(lp); o2.connect(lp); lp.connect(gain);
  if (pan) { gain.connect(pan); pan.connect(master); } else { gain.connect(master); }
  o1.start(); o2.start();
  buzz = { gain, pan };
}

// World (x,y) → { pan [-1..1], centerProx [0..1], onScreen } using the live
// camera. pan follows horizontal screen position; centerProx fades from 1 at
// screen-centre to 0 past the edges.
function spatial(x, y) {
  const W = state.W, H = state.H, z = state.zoom;
  const sx = (x - state.cameraX) * z;
  const sy = (y - state.cameraY) * z;
  let pan = (sx / W) * 2 - 1;
  pan = clamp(pan, -1, 1);
  const ddx = sx - W / 2, ddy = sy - H / 2;
  const half = Math.hypot(W / 2, H / 2) || 1;
  const centerProx = clamp(1 - Math.hypot(ddx, ddy) / (half * 1.15), 0, 1);
  return { pan, centerProx };
}

// ---- Per-frame update: drone swarm buzz + AA gunfire scan ----
export function updateAudio(dt) {
  if (!actx || actx.state !== 'running') return;
  frameExplosions = 0;
  updateBuzz();
  scanAAFire(dt);
}

function updateBuzz() {
  if (!buzz) return;
  const zoomF = clamp((state.zoom - ZOOM_AUDIBLE_MIN) / (ZOOM_AUDIBLE_FULL - ZOOM_AUDIBLE_MIN), 0, 1);
  let energy = 0, panSum = 0;
  if (zoomF > 0) {
    const { vL, vT, vR, vB } = state._view;
    let count = 0;
    for (const f of state.fleets) {
      if (f.kind !== 'drone') continue;
      if (f.x < vL || f.x > vR || f.y < vT || f.y > vB) continue;
      const s = spatial(f.x, f.y);
      if (s.centerProx <= 0) continue;
      energy += s.centerProx;
      panSum += s.pan * s.centerProx;
      if (++count >= 64) break;          // bound the work in a huge swarm
    }
  }
  const targetGain = zoomF * Math.min(1, energy / 4) * DRONE_BUZZ_VOL;
  const targetPan  = energy > 0 ? panSum / energy : 0;
  const now = actx.currentTime;
  buzz.gain.gain.setTargetAtTime(targetGain, now, 0.08);   // smooth → no clicks
  if (buzz.pan) buzz.pan.pan.setTargetAtTime(targetPan, now, 0.08);
}

function scanAAFire(dt) {
  if (muted) return;
  // AA rounds spawned THIS frame (age still ~dt) = gunfire events. Rate-limited
  // so a big battle is a rattle, not a wall of noise.
  const fresh = dt * 1.6;
  const { vL, vT, vR, vB } = state._view;
  let fired = 0;
  for (const t of state.tracers) {
    if (t.kind !== 'aa' || t.age > fresh) continue;
    if (t.x1 < vL || t.x1 > vR || t.y1 < vT || t.y1 > vB) continue;
    const s = spatial(t.x1, t.y1);
    if (s.centerProx <= 0.03) continue;
    playGunshot(s.pan, s.centerProx);
    if (++fired >= 3) break;             // ≤3 shots/frame → dense but not a roar
  }
}

// ---- One-shot voices ----
function playBuffer(buf, pan, gain, rate = 1) {
  const now = actx.currentTime;
  const src = actx.createBufferSource();
  src.buffer = buf; src.playbackRate.value = rate;
  const g = actx.createGain(); g.gain.value = gain;
  let tail = g;
  if (actx.createStereoPanner) { const p = actx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); g.connect(p); tail = p; }
  src.connect(g); tail.connect(master);
  src.start(now);
}

function playGunshot(pan, gain) {
  if (customBuffers.aa) { playBuffer(customBuffers.aa, pan, gain * 0.9, 0.9 + Math.random() * 0.2); return; }
  const now = actx.currentTime;
  const src = actx.createBufferSource();
  src.buffer = noiseBuf;
  src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.3;
  const bp = actx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 1700 + Math.random() * 700; bp.Q.value = 0.7;
  const g = actx.createGain();
  g.gain.setValueAtTime(0.26 * gain, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
  src.connect(bp); bp.connect(g);
  let tail = g;
  if (actx.createStereoPanner) { const p = actx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); g.connect(p); tail = p; }
  tail.connect(master);
  src.start(now); src.stop(now + 0.07);
}

/** Boom for a fleet/drone death. scale ~ explosion size. Spatialised + capped. */
export function sfxExplosion(x, y, scale = 1) {
  if (!actx || actx.state !== 'running' || muted) return;
  if (frameExplosions >= 4) return;
  const s = spatial(x, y);
  if (s.centerProx <= 0.03) return;
  frameExplosions++;
  const gain = s.centerProx * Math.min(1.3, 0.5 + state.zoom * 0.4);
  if (customBuffers.explosion) { playBuffer(customBuffers.explosion, s.pan, gain * 0.9); return; }
  const now = actx.currentTime;
  const src = actx.createBufferSource();
  src.buffer = noiseBuf; src.playbackRate.value = 0.5 + Math.random() * 0.2;
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(900, now);
  lp.frequency.exponentialRampToValueAtTime(110, now + 0.3);
  const g = actx.createGain();
  g.gain.setValueAtTime(0.5 * gain * clamp(scale, 0.4, 2), now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
  src.connect(lp); lp.connect(g);
  let tail = g;
  if (actx.createStereoPanner) { const p = actx.createStereoPanner(); p.pan.value = clamp(s.pan, -1, 1); g.connect(p); tail = p; }
  tail.connect(master);
  src.start(now); src.stop(now + 0.4);
}

/** Rising two-tone blip when a node changes hands. Spatialised. */
export function sfxCapture(x, y) {
  if (!actx || actx.state !== 'running' || muted) return;
  const s = spatial(x, y);
  if (s.centerProx <= 0.03) return;
  const gain = s.centerProx * 0.5;
  if (customBuffers.capture) { playBuffer(customBuffers.capture, s.pan, gain); return; }
  const now = actx.currentTime;
  const osc = actx.createOscillator(); osc.type = 'triangle';
  osc.frequency.setValueAtTime(520, now);
  osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.22 * gain, now + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
  osc.connect(g);
  let tail = g;
  if (actx.createStereoPanner) { const p = actx.createStereoPanner(); p.pan.value = clamp(s.pan, -1, 1); g.connect(p); tail = p; }
  tail.connect(master);
  osc.start(now); osc.stop(now + 0.24);
}

// ---- Mute ----
export function toggleMute() {
  muted = !muted;
  if (master && actx) master.gain.setTargetAtTime(muted ? 0 : MASTER_VOL, actx.currentTime, 0.05);
  return muted;
}
export function isAudioMuted() { return muted; }

/** Internal: snapshot of the audio graph for diagnostics / tests. */
export function _audioDebug() {
  return {
    hasCtx: !!actx,
    ctxState: actx ? actx.state : 'none',
    muted, hasBuzz: !!buzz,
    buzzGain: buzz ? buzz.gain.gain.value : null,
    customLoaded: Object.keys(customBuffers),
  };
}

// ---- Upload channel: override synth with custom files when listed ----
async function loadCustomManifest() {
  let names;
  try {
    const res = await fetch('assets/sfx-manifest.json');
    if (!res.ok) return;
    names = await res.json();
  } catch { return; }
  if (!Array.isArray(names)) return;
  const EXTS = ['mp3', 'ogg', 'wav', 'webm'];
  for (const name of names) {
    for (const ext of EXTS) {
      try {
        const r = await fetch(`assets/sfx/${name}.${ext}`);
        if (!r.ok) continue;
        customBuffers[name] = await actx.decodeAudioData(await r.arrayBuffer());
        break;
      } catch { /* try next ext */ }
    }
  }
}
