// =====================================================
// Camera: pan / zoom / clamping. Reads & writes state.{cameraX,cameraY,zoom,W,H}.
// =====================================================
import { state } from './state.js';
import { WORLD_W, WORLD_H, ZOOM_MIN, ZOOM_MAX } from './config.js';

export function clampCamera() {
  const { W, H, zoom } = state;
  const visW = W / zoom, visH = H / zoom;
  if (visW >= WORLD_W) state.cameraX = (WORLD_W - visW) / 2;
  else state.cameraX = Math.max(0, Math.min(WORLD_W - visW, state.cameraX));
  if (visH >= WORLD_H) state.cameraY = (WORLD_H - visH) / 2;
  else state.cameraY = Math.max(0, Math.min(WORLD_H - visH, state.cameraY));
}

/** Zoom around screen-point (ax, ay) by `factor`. */
export function zoomBy(factor, ax, ay) {
  const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.zoom * factor));
  if (newZoom === state.zoom) return;
  const wx = ax / state.zoom + state.cameraX;
  const wy = ay / state.zoom + state.cameraY;
  state.zoom = newZoom;
  state.cameraX = wx - ax / state.zoom;
  state.cameraY = wy - ay / state.zoom;
  clampCamera();
}
