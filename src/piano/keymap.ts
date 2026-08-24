// The computer-keyboard mapping, in the layout most virtual pianos use: the
// bottom two rows are one octave, the top two are the octave above, so both
// hands land somewhere sensible without being told.
//
// Bindings are by `KeyboardEvent.code` (physical position), not `key`, so the
// shape of the mapping survives a non-QWERTY layout.

export interface KeyBinding {
  /** KeyboardEvent.code */
  code: string;
  /** Semitones above the lower row's base note. */
  offset: number;
  /** What to print on the piano key, for the player who looks down. */
  label: string;
}

/** Lower manual: Z-row whites, S-row blacks. Starts at the base note. */
const LOWER: [string, number, string][] = [
  ["KeyZ", 0, "Z"],
  ["KeyS", 1, "S"],
  ["KeyX", 2, "X"],
  ["KeyD", 3, "D"],
  ["KeyC", 4, "C"],
  ["KeyV", 5, "V"],
  ["KeyG", 6, "G"],
  ["KeyB", 7, "B"],
  ["KeyH", 8, "H"],
  ["KeyN", 9, "N"],
  ["KeyJ", 10, "J"],
  ["KeyM", 11, "M"],
  ["Comma", 12, ","],
  ["KeyL", 13, "L"],
  ["Period", 14, "."],
  ["Semicolon", 15, ";"],
  ["Slash", 16, "/"],
];

/** Upper manual: Q-row whites, number-row blacks. One octave above the base. */
const UPPER: [string, number, string][] = [
  ["KeyQ", 12, "Q"],
  ["Digit2", 13, "2"],
  ["KeyW", 14, "W"],
  ["Digit3", 15, "3"],
  ["KeyE", 16, "E"],
  ["KeyR", 17, "R"],
  ["Digit5", 18, "5"],
  ["KeyT", 19, "T"],
  ["Digit6", 20, "6"],
  ["KeyY", 21, "Y"],
  ["Digit7", 22, "7"],
  ["KeyU", 23, "U"],
  ["KeyI", 24, "I"],
  ["Digit9", 25, "9"],
  ["KeyO", 26, "O"],
  ["Digit0", 27, "0"],
  ["KeyP", 28, "P"],
  ["BracketLeft", 29, "["],
  ["Equal", 30, "="],
  ["BracketRight", 31, "]"],
];

// The two manuals overlap by an octave (Comma..Slash meet Q..E). The upper row
// wins for those pitches when labelling a key, because that is the row a player
// reaches for; both codes still sound.
export const KEY_BINDINGS: readonly KeyBinding[] = [...LOWER, ...UPPER].map(
  ([code, offset, label]) => ({ code, offset, label }),
);

export const DEFAULT_BASE_MIDI = 48; // C3, so the upper manual sits at middle C
export const MIN_BASE_MIDI = 24;
export const MAX_BASE_MIDI = 72;

/** code -> MIDI note, for a given base note. */
export function keymapForBase(baseMidi: number): Map<string, number> {
  const map = new Map<string, number>();
  for (const { code, offset } of KEY_BINDINGS) map.set(code, baseMidi + offset);
  return map;
}

/** MIDI note -> the letter printed on that key, for a given base note. */
export function labelsForBase(baseMidi: number): Map<number, string> {
  const labels = new Map<number, string>();
  for (const { offset, label } of KEY_BINDINGS) labels.set(baseMidi + offset, label);
  return labels;
}

export function clampBaseMidi(base: number): number {
  return Math.min(MAX_BASE_MIDI, Math.max(MIN_BASE_MIDI, base));
}
