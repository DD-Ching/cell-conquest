// =====================================================
// Pure helpers — no state, no DOM.
// =====================================================

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function formatTime(s) {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
}
