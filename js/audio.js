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
// Spatialisation (the player's spec — "有方向,有遠近,有大小,身歷其境"): every
// sound at world (x,y) is placed by the CURRENT VIEW, so the battlefield sounds
// 3D. spatial() returns four cues, and EVERY voice (buzz, AA gunfire,
// explosions, captures, uploaded SFX) is routed through them:
//   • pan        — left/right from horizontal screen position (左/右)
//   • proximity  — volume: loud near screen-centre, quieter to the edges, and
//                  attenuated by ZOOM-AS-ALTITUDE (zoomed out = high above the
//                  field = everything more distant + quieter) (遠/近)
//   • brightness — drives a per-voice low-pass: near sounds are crisp, far
//                  sounds are MUFFLED. This is the visceral "遠近不一樣" cue.
//   • on-screen edge falloff folded into proximity so off-view sounds fade to
//                  silence (you don't hear what you can't see).
// Size (大小) is per-sound (explosion scale → louder + lower-pitched); density
// (密集/多) is the natural overlap of many capped one-shot voices + the swarm
// buzz energy sum. See spatial() + spatialTail().
//
// Browser autoplay policy: an AudioContext can't start before a user gesture,
// so the context is created/resumed on the first pointerdown / keydown.
// =====================================================
import { state } from './state.js';

const MASTER_VOL      = 0.5;
const DRONE_BUZZ_VOL  = 0.30;
const ZOOM_AUDIBLE_MIN = 1.2;   // below this zoom, drones are silent
const ZOOM_AUDIBLE_FULL = 2.0;  // at/above this zoom, drone buzz is at full strength
// Zoom-as-altitude for one-shot spatialisation. At/above NEAR the listener is
// "on the ground" (no altitude attenuation); at/below FAR it's "high above" the
// theatre (full attenuation + muffling). Between, it lerps — so zooming out
// pulls every boom/gunshot into the distance.
const ZOOM_AUDIO_NEAR = 1.6;
const ZOOM_AUDIO_FAR  = 0.45;

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

// World (x,y) → { pan, proximity, brightness, onScreen } using the live camera.
// pan: horizontal screen position (-1 left .. +1 right). proximity: 0..1 volume
// from radial screen-distance + zoom-altitude, with an edge falloff so off-view
// sounds reach 0. brightness: 1 near/crisp .. ~0.1 far/muffled (drives the
// per-voice low-pass). See the header for the full rationale.
function spatial(x, y) {
  const W = state.W, H = state.H, z = state.zoom;
  const sx = (x - state.cameraX) * z;
  const sy = (y - state.cameraY) * z;
  // Normalised screen offset from centre: 0 at centre, ±1 at each edge midpoint.
  const ddx = (sx - W / 2) / (W / 2);
  const ddy = (sy - H / 2) / (H / 2);
  const pan = clamp(ddx, -1, 1);
  // Edge falloff via the Chebyshev inset (==1 at ANY screen edge incl. corners):
  // full inside the view, fading to 0 by 1.5× past the edge → off-screen silence.
  const inset = Math.max(Math.abs(ddx), Math.abs(ddy));
  const edge = clamp(1 - (inset - 1) / 0.5, 0, 1);
  // Radial distance (for volume) + zoom-altitude (zoomed out ⇒ far/high above).
  const radial = Math.hypot(ddx, ddy);
  const alt = clamp((ZOOM_AUDIO_NEAR - z) / (ZOOM_AUDIO_NEAR - ZOOM_AUDIO_FAR), 0, 1);
  const dist = radial * 0.6 + alt * 0.8;
  const proximity = edge * clamp(1 / (1 + dist * dist * 1.2), 0, 1);
  const brightness = clamp(1 - (radial * 0.4 + alt * 0.5), 0.1, 1);
  return { pan, proximity, brightness, onScreen: inset < 1.25 };
}

// Append the spatial tail to a voice's gain node: a distance LOW-PASS (near =
// open/transparent, far = muffled) then a stereo PAN, into master. One Biquad +
// one StereoPanner per one-shot voice — cheap, and voices are capped (≤3
// gunshots, ≤4 explosions per frame). This is what gives every sound the same
// directional, near/far body the drone buzz has.
function spatialTail(g, pan, brightness) {
  const cutoff = 700 + brightness * brightness * 17000;   // ~700 Hz far .. ~17.7 kHz near
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = cutoff;
  g.connect(lp);
  let tail = lp;
  if (actx.createStereoPanner) {
    const p = actx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    tail.connect(p); tail = p;
  }
  tail.connect(master);
}

// ---- Per-frame update: drone swarm buzz + AA gunfire scan ----
export function updateAudio(dt) {
  if (!actx || actx.state !== 'running') return;
  frameExplosions = 0;
  updateBuzz();
  scanAAFire(dt);
}

// View bounds derived straight from the camera (NOT state._view): when the
// render worker owns drawing, render() runs off-thread and never sets
// state._view on the main thread, so audio must compute its own visible box or
// it crashes every frame. No margin needed — audio only cares about on-screen.
function viewBounds() {
  const z = state.zoom || 1;
  return {
    vL: state.cameraX, vT: state.cameraY,
    vR: state.cameraX + state.W / z, vB: state.cameraY + state.H / z,
  };
}

function updateBuzz() {
  if (!buzz) return;
  const zoomF = clamp((state.zoom - ZOOM_AUDIBLE_MIN) / (ZOOM_AUDIBLE_FULL - ZOOM_AUDIBLE_MIN), 0, 1);
  let energy = 0, panSum = 0;
  if (zoomF > 0) {
    const { vL, vT, vR, vB } = viewBounds();
    let count = 0;
    for (const f of state.fleets) {
      if (f.kind !== 'drone') continue;
      if (f.x < vL || f.x > vR || f.y < vT || f.y > vB) continue;
      const s = spatial(f.x, f.y);
      if (s.proximity <= 0) continue;
      energy += s.proximity;
      panSum += s.pan * s.proximity;
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
  const { vL, vT, vR, vB } = viewBounds();
  let fired = 0;
  for (const t of state.tracers) {
    if (t.kind !== 'aa' || t.age > fresh) continue;
    if (t.x1 < vL || t.x1 > vR || t.y1 < vT || t.y1 > vB) continue;
    const s = spatial(t.x1, t.y1);
    if (s.proximity <= 0.03) continue;
    playGunshot(s);
    if (++fired >= 3) break;             // ≤3 shots/frame → dense but not a roar
  }
}

// ---- One-shot voices ----
// All take the spatial cue object `s` ({pan, proximity, brightness}) and route
// through spatialTail so uploads and synth voices share the same 3D placement.
function playBuffer(buf, s, gainScale = 1, rate = 1) {
  const now = actx.currentTime;
  const src = actx.createBufferSource();
  src.buffer = buf; src.playbackRate.value = rate;
  const g = actx.createGain(); g.gain.value = gainScale * s.proximity;
  src.connect(g);
  spatialTail(g, s.pan, s.brightness);
  src.start(now);
}

function playGunshot(s) {
  if (customBuffers.aa) { playBuffer(customBuffers.aa, s, 0.9, 0.9 + Math.random() * 0.2); return; }
  const now = actx.currentTime;
  const src = actx.createBufferSource();
  src.buffer = noiseBuf;
  src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.3;
  const bp = actx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 1700 + Math.random() * 700; bp.Q.value = 0.7;
  const g = actx.createGain();
  g.gain.setValueAtTime(0.26 * s.proximity, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
  src.connect(bp); bp.connect(g);
  spatialTail(g, s.pan, s.brightness);
  src.start(now); src.stop(now + 0.07);
}

/** Boom for a fleet/drone death. scale ~ explosion size. Spatialised + capped. */
export function sfxExplosion(x, y, scale = 1) {
  if (!actx || actx.state !== 'running' || muted) return;
  if (frameExplosions >= 4) return;
  const s = spatial(x, y);
  if (s.proximity <= 0.03) return;
  frameExplosions++;
  const sz = clamp(scale, 0.4, 2);                 // size (大小): louder + lower-pitched
  if (customBuffers.explosion) { playBuffer(customBuffers.explosion, s, 0.9 * sz, 0.85 + Math.random() * 0.2); return; }
  const now = actx.currentTime;
  const src = actx.createBufferSource();
  src.buffer = noiseBuf; src.playbackRate.value = 0.5 + Math.random() * 0.2;
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(900, now);
  lp.frequency.exponentialRampToValueAtTime(110, now + 0.3);
  const g = actx.createGain();
  g.gain.setValueAtTime(0.5 * s.proximity * sz, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
  src.connect(lp); lp.connect(g);
  spatialTail(g, s.pan, s.brightness);
  src.start(now); src.stop(now + 0.4);
}

/** Rising two-tone blip when a node changes hands. Spatialised. */
export function sfxCapture(x, y) {
  if (!actx || actx.state !== 'running' || muted) return;
  const s = spatial(x, y);
  if (s.proximity <= 0.03) return;
  if (customBuffers.capture) { playBuffer(customBuffers.capture, s, 0.5); return; }
  const now = actx.currentTime;
  const osc = actx.createOscillator(); osc.type = 'triangle';
  osc.frequency.setValueAtTime(520, now);
  osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.22 * s.proximity * 0.5, now + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
  osc.connect(g);
  spatialTail(g, s.pan, s.brightness);
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
