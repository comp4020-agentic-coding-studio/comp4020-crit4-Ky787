// The 88-key layout, as pure geometry. The piano DOM and the falling-note
// canvas both need to agree on where a given MIDI note sits horizontally, so
// the layout lives in one place and neither owns it.

export const LOWEST_MIDI = 21; // A0
export const HIGHEST_MIDI = 108; // C8
export const KEY_COUNT = HIGHEST_MIDI - LOWEST_MIDI + 1; // 88
export const WHITE_KEY_COUNT = 52;

const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

export function isBlackKey(midi: number): boolean {
  return BLACK_PITCH_CLASSES.has(((midi % 12) + 12) % 12);
}

/** How many white keys sit strictly below `midi`, counting from A0. */
export function whiteKeysBelow(midi: number): number {
  let count = 0;
  for (let n = LOWEST_MIDI; n < midi; n++) if (!isBlackKey(n)) count++;
  return count;
}

export interface KeyBox {
  midi: number;
  black: boolean;
  /** Left edge, as a fraction of the keyboard's width. */
  x: number;
  /** Width, as a fraction of the keyboard's width. */
  width: number;
  /** Horizontal centre, as a fraction of the keyboard's width. */
  centre: number;
}

/**
 * A black key is narrower than a white one and straddles the seam between the
 * two whites it sits between, which is why its centre is the seam position
 * rather than the centre of any white key.
 */
const BLACK_WIDTH_RATIO = 0.62;

/** The layout in fractions of the keyboard width, low note first. */
export function keyLayout(): KeyBox[] {
  const white = 1 / WHITE_KEY_COUNT;
  const black = white * BLACK_WIDTH_RATIO;
  const boxes: KeyBox[] = [];
  for (let midi = LOWEST_MIDI; midi <= HIGHEST_MIDI; midi++) {
    const below = whiteKeysBelow(midi);
    if (isBlackKey(midi)) {
      const seam = below * white;
      boxes.push({ midi, black: true, x: seam - black / 2, width: black, centre: seam });
    } else {
      const x = below * white;
      boxes.push({ midi, black: false, x, width: white, centre: x + white / 2 });
    }
  }
  return boxes;
}

/** Note centres indexed by MIDI number, as width fractions; -1 off-keyboard. */
export function centresByMidi(): Float64Array {
  const centres = new Float64Array(128).fill(-1);
  for (const box of keyLayout()) centres[box.midi] = box.centre;
  return centres;
}

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

export function noteName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}
