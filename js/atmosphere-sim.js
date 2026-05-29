// =====================================================
// Atmosphere SIM — per-tick state-update half of the atmosphere layer.
//
// Split out of render-atmosphere.js (which kept the draw* fns). These are
// not draw functions, but they are presentation-only — they advance dust,
// particle, and weather state that ONLY the atmosphere draw layers read.
// Nothing here is queried by sim/AI/pathing, so it lives on the render side,
// not in the gameplay sim. render-atmosphere.js re-exports the public names
// (makeSnow / updateSnow / updateParticles / makeDustLayer) so importers are
// unchanged.
//
// Contents:
//  - makeSnow / updateSnow / updateParticles — the lifecycle entry points.
//  - makeDustLayer (exported: the generalized dust constructor) + the private
//    advance-state helpers (stepDustLayer, updateWeather, spawnStormGrit).
// =====================================================
import { state } from './state.js';
import { PARTICLE_CAP } from './config.js';

// =====================================================
// Atmosphere lifecycle (dust + particles + weather)
// =====================================================

// Mars dust — drifts mostly sideways with slow vertical haze. Two parallax
// layers: state.dust (foreground) + state.dustFar (background, half density &
// speed). makeSnow seeds both; the name stays makeSnow so main.js / the render
// worker keep their existing imports. (makeDustLayer is in the private section.)
export function makeSnow() {
  const fgCount = Math.floor((state.W * state.H) / 14000);
  makeDustLayer(state.dust = [], fgCount, 1.0, 1.0);
  // Background layer: half the particles, smaller, slower (speedMul stamped on
  // each particle drives the slower advance in stepDustLayer).
  makeDustLayer(state.dustFar = [], Math.floor(fgCount * 0.5), 0.7, 0.5);
}

export function updateSnow(dt) {
  // Advance the weather state machine first — a sand storm injects extra grit
  // into the foreground layer, so it must be current before we step particles.
  updateWeather(dt);
  stepDustLayer(state.dustFar, dt);
  stepDustLayer(state.dust, dt);
  // Storm grit: while a storm is blowing, top up the foreground layer with
  // fast transient particles so the air visibly thickens. Bounded per frame.
  spawnStormGrit(dt);
}

export function updateParticles(dt) {
  // FIFO budget: spawn sites are unbounded, so cap here. Loop iterates from
  // the END, so splicing OLDEST entries off the front first does not shift
  // any index we are about to visit. Drops the eldest particles (which are
  // also the most faded — alpha is life/maxLife), which is exactly what a
  // human eye would lose first anyway.
  if (state.particles.length > PARTICLE_CAP) {
    state.particles.splice(0, state.particles.length - PARTICLE_CAP);
  }
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const p = state.particles[i];
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= 0.95; p.vy *= 0.95;
    p.life -= dt;
    if (p.life <= 0) state.particles.splice(i, 1);
  }
}

// =====================================================
// Private helpers — shared dust-layer plumbing + the weather state machine.
// (makeDustLayer is exported because the unit spec names it as the generalized
// dust constructor; the rest are module-private.)
// =====================================================

// Seed `arr` with `count` grit particles. sizeMul scales radius; speedMul is
// stamped on each particle so stepDustLayer can advance far/near layers at
// different rates without a second update fn.
export function makeDustLayer(arr, count, sizeMul, speedMul) {
  for (let i = 0; i < count; i++) {
    arr.push({
      x: Math.random() * state.W, y: Math.random() * state.H,
      vx: 18 + Math.random() * 30,            // wind blowing right
      vy: -4 + Math.random() * 10,            // slight vertical drift
      r: (0.5 + Math.random() * 1.4) * sizeMul,
      a: 0.18 + Math.random() * 0.4,
      drift: Math.random() * Math.PI * 2,
      hue: 18 + Math.random() * 22,           // 18..40 = sandy orange range
      speedMul,
    });
  }
}

// Advance one dust array. speedMul (stamped at creation) lets the background
// layer crawl while the foreground races, selling parallax depth.
function stepDustLayer(arr, dt) {
  const now = performance.now();
  for (const s of arr) {
    const sm = s.speedMul || 1;
    s.x += (s.vx * sm + Math.sin(now / 1500 + s.drift) * 4 * sm) * dt;
    s.y += s.vy * sm * dt;
    if (s.x > state.W + 5) { s.x = -5; s.y = Math.random() * state.H; }
    if (s.x < -5) s.x = state.W + 5;
    if (s.y > state.H + 5) s.y = -5;
    if (s.y < -5) s.y = state.H + 5;
  }
}

// Mars weather state machine. Picks a new target every ~60 game-seconds
// (0 = clear, 0.3 = light haze, 0.7 = sand storm) and lerps intensity toward
// it over ~10 s. Pure presentation — nothing here is read by sim/AI/pathing.
function updateWeather(dt) {
  const w = state.weather;
  if (!w) return;
  // Gate the target pick on game-elapsed so a fast time-scale doesn't churn
  // the weather every frame.
  if (state.elapsed - w.lastChangeT > 60) {
    w.lastChangeT = state.elapsed;
    const roll = Math.random();
    w.target = roll < 0.45 ? 0 : roll < 0.8 ? 0.3 : 0.7;
  }
  // Glide intensity → target. ~10 s time constant, frame-rate independent.
  const k = Math.min(1, dt / 10);
  w.intensity += (w.target - w.intensity) * k;
  if (Math.abs(w.intensity - w.target) < 0.001) w.intensity = w.target;
}

// Keep the foreground dust count tracking the weather: thicken the air with
// extra fast grit as a storm rises, and trim that grit back out as it clears so
// calm weather returns to base density. Bounded at base + maxWant either way.
function spawnStormGrit(dt) {
  const intensity = state.weather ? state.weather.intensity : 0;
  const base = Math.floor((state.W * state.H) / 14000);
  const arr = state.dust;
  // Target foreground count for the current intensity. <=0.3 collapses to base.
  const want = intensity > 0.3 ? Math.floor(base * intensity * 0.6) : 0;
  const target = base + want;
  if (arr.length < target) {
    // Spawn extra storm grit from the left edge (fast gusts).
    const add = Math.min(target - arr.length, Math.ceil(base * dt * 2) + 1);
    for (let i = 0; i < add; i++) {
      arr.push({
        x: -5, y: Math.random() * state.H,
        vx: 60 + Math.random() * 90,          // storm gusts move FAST
        vy: -8 + Math.random() * 20,
        r: 0.6 + Math.random() * 1.8,
        a: 0.25 + Math.random() * 0.45,
        drift: Math.random() * Math.PI * 2,
        hue: 16 + Math.random() * 18,
        speedMul: 1.0, storm: true,
      });
    }
  } else if (arr.length > target) {
    // Storm easing — pop the surplus storm grit a few per frame so density
    // glides back to base without a visible pop. Only remove `storm` particles
    // (never the original base layer); guard against an empty pop.
    let remove = Math.min(arr.length - target, Math.ceil(base * dt * 2) + 1);
    for (let i = arr.length - 1; i >= 0 && remove > 0; i--) {
      if (arr[i].storm) { arr.splice(i, 1); remove--; }
    }
  }
}
