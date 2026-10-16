// Remembers the UI state across reloads, as one JSON object in localStorage under
// flat keys such as 'switch.toggle-places' or 'print.size'. Storage can be missing
// or throw (private windows, blocked site data); then nothing is remembered and the
// defaults apply. Stored values may be stale, so callers check them before use.

const STORAGE_KEY = 'topomap';

const state = (() => {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
})();

/** The stored value for `key`, or undefined. */
export function load(key) {
  return state[key];
}

/** A stored finite number for `key`, or `fallback`. */
export function loadNumber(key, fallback) {
  const value = state[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function save(key, value) {
  state[key] = value;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Not remembered; the UI works the same.
  }
}
