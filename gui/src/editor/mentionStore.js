/**
 * The bridge between TipTap's suggestion plugin and the React menu.
 *
 * The plugin runs inside ProseMirror and has to answer `onKeyDown`
 * synchronously, while the menu is a React tree outside the editor. Keeping the
 * state in one small external store lets the plugin own the keys and the menu
 * own the pixels, without either reaching into the other's internals.
 */

let state = { open: false, items: [], active: 0, rect: null, onPick: null };
const listeners = new Set();

export function subscribeMention(listener) {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

export function mentionSnapshot() {
  return state;
}

export function publishMention(next) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener(state));
}

export function hideMention() {
  if (!state.open) return;
  state = { ...state, open: false, onPick: null };
  listeners.forEach((listener) => listener(state));
}
