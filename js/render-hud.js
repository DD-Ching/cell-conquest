// =====================================================
// DOM HUD — Forces roster (top-left) + Timer / Speed / Zoom (top-right).
// Built once per game in buildHUD(); updated ~10 Hz from updateHUD().
//
// Pure DOM — no canvas, no state mutation other than reading.
// =====================================================
import { state } from './state.js';
import { FACTIONS, factionStats } from './factions.js';
import { formatTime } from './util.js';

// Cached DOM refs — populated by buildHUD, reused by updateHUD so we don't
// re-getElementById 10+ times per frame.
const _hudEls = { unitsByFaction: {}, nodesByFaction: {}, timer: null, zoom: null, speed: null };
let _hudLastT = 0;

export function buildHUD() {
  const hud = document.getElementById('hud');
  if (!hud) return;
  hud.innerHTML = '<div class="hud-header">Forces</div>';
  for (const f of FACTIONS) {
    if (f.id === 'neutral') continue;     // neutral isn't a competing force
    const stats = factionStats[f.id];
    const strength = stats ? stats.strength : 1.0;
    const fillPct = Math.max(0, Math.min(100, ((strength - 0.5) / 1.0) * 100));
    const isPlayer = f.id === 'player';
    const tag = isPlayer ? 'BASE' : (
      strength >= 1.15 ? 'STRONG'
      : strength >= 1.00 ? 'STEADY'
      : 'WEAK'
    );
    const row = document.createElement('div');
    row.className = 'faction-row';
    row.style.color = f.color;
    row.innerHTML = `
      <span class="swatch" style="background:${f.color}"></span>
      <span class="name" style="color:${f.color}">${f.name}</span>
      <span class="stats">
        <span class="u" id="${f.id}-units">0</span><span class="lbl">u</span>
        <span class="n" id="${f.id}-nodes">0</span><span class="lbl">n</span>
      </span>
      <div class="strength-row" title="${isPlayer ? 'You (baseline)' : `Strength: ${strength.toFixed(2)} — ${tag}`}">
        <div class="fill" style="width:${fillPct}%; color:${f.color}"></div>
      </div>
    `;
    hud.appendChild(row);
  }
  // Resolve all the per-update DOM refs once. updateHUD reads from the cache.
  _hudEls.unitsByFaction = {};
  _hudEls.nodesByFaction = {};
  for (const f of FACTIONS) {
    _hudEls.unitsByFaction[f.id] = document.getElementById(`${f.id}-units`);
    _hudEls.nodesByFaction[f.id] = document.getElementById(`${f.id}-nodes`);
  }
  _hudEls.timer = document.getElementById('timer');
  _hudEls.zoom  = document.getElementById('zoom');
  _hudEls.speed = document.getElementById('speed');
  _hudLastT = 0;
}

export function updateHUD() {
  // Throttle to ~10 Hz. HUD counters changing 60×/sec aren't noticeably more
  // responsive than 10×/sec, and DOM writes are real per-frame work.
  const now = performance.now();
  if (now - _hudLastT < 100) return;
  _hudLastT = now;

  const c = {};
  for (const f of FACTIONS) c[f.id] = [0, 0];
  for (const n of state.nodes) {
    c[n.owner][0] += n.units;
    c[n.owner][1] += 1;
  }
  for (const f of state.fleets) if (c[f.owner]) c[f.owner][0] += (f.units || 0);
  for (const f of FACTIONS) {
    const u = _hudEls.unitsByFaction[f.id];
    const ns = _hudEls.nodesByFaction[f.id];
    if (u) u.textContent = Math.floor(c[f.id][0]);
    if (ns) ns.textContent = c[f.id][1];
  }
  if (_hudEls.timer) _hudEls.timer.textContent = formatTime(state.elapsed);
  if (_hudEls.zoom)  _hudEls.zoom.textContent  = `${Math.round(state.zoom * 100)}%`;
  if (_hudEls.speed) _hudEls.speed.textContent = `Speed ${state.timeScale}×`;
}
