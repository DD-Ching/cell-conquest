// =====================================================
// Single source of truth for the tutorial's PROGRESSIVE LOCKS.
//
// Outside a tutorial (state.tutorial === null) everything is allowed and the
// camera is free — every gate below is a no-op, so normal play is unchanged.
// Inside a tutorial, a capability stays LOCKED until its lesson adds the token
// to state.tutorial.unlocked (see lobby.js enterStep). input.js, main.js and
// render-shroud.js all consult these so there is exactly one lock definition.
//
// Tokens: 'view' (camera pan + zoom), 'vision' (fog shroud), 'select', 'send',
// 'build', 'speed', 'command'.
// =====================================================
import { state } from './state.js';

/** A capability is allowed when there's no tutorial, or its token is unlocked. */
export function tutAllows(cap) {
  return !state.tutorial || state.tutorial.unlocked.has(cap);
}

/** Camera pan + zoom are frozen until the tutorial's 'view' lesson unlocks. */
export function cameraLocked() {
  return !!state.tutorial && !state.tutorial.unlocked.has('view');
}

/** The tutorial vision shroud is up until the 'vision' lesson unlocks. */
export function visionLocked() {
  return !!state.tutorial && !state.tutorial.unlocked.has('vision');
}
