// The piano itself: 88 keys, built once as DOM, driven by pointer, touch and
// the computer keyboard.
//
// DOM rather than canvas because a key is a physical thing with a lit state and
// a pressed state, and CSS says that in a line where canvas needs a paint
// routine. 88 nodes is nothing; the waterfall above is where the note count
// actually bites.

import { keyLayout, noteName, type KeyBox } from "./geometry.ts";
import { clampBaseMidi, DEFAULT_BASE_MIDI, keymapForBase, labelsForBase } from "./keymap.ts";

export interface KeyboardCallbacks {
  onNoteOn: (midi: number, velocity: number) => void;
  onNoteOff: (midi: number) => void;
  onSustain: (down: boolean) => void;
  /** Anything the player does that should wake the audio context. */
  onGesture: () => void;
}

/** Struck near the top of a key is soft, near the bottom is loud — the same
 *  way key dip maps to loudness on a real action. */
export function velocityFromDepth(depth: number): number {
  const clamped = Math.min(1, Math.max(0, depth));
  return Math.round(48 + clamped * 79); // 48..127
}

export const TYPED_VELOCITY = 88;

export class Piano {
  private readonly keys = new Map<number, HTMLElement>();
  private readonly held = new Set<number>();
  private readonly litByPlayback = new Set<number>();
  /** Which MIDI note each active pointer is currently holding. */
  private readonly pointers = new Map<number, number>();
  private readonly typed = new Set<string>();
  private keymap = keymapForBase(DEFAULT_BASE_MIDI);
  private baseMidi = DEFAULT_BASE_MIDI;
  private sustaining = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly callbacks: KeyboardCallbacks,
  ) {
    this.build();
    this.bindPointer();
    this.bindKeyboard();
    this.relabel();
  }

  private build(): void {
    this.root.innerHTML = "";
    const whites = document.createElement("div");
    whites.className = "piano-row piano-row--white";
    const blacks = document.createElement("div");
    blacks.className = "piano-row piano-row--black";

    for (const box of keyLayout()) {
      const key = this.buildKey(box);
      this.keys.set(box.midi, key);
      (box.black ? blacks : whites).append(key);
    }
    this.root.append(whites, blacks);
  }

  private buildKey(box: KeyBox): HTMLElement {
    const key = document.createElement("div");
    key.className = `piano-key ${box.black ? "is-black" : "is-white"}`;
    key.dataset.midi = String(box.midi);
    key.style.left = `${box.x * 100}%`;
    key.style.width = `${box.width * 100}%`;
    key.setAttribute("aria-hidden", "true");
    if (box.midi % 12 === 0) key.classList.add("is-c");
    const label = document.createElement("span");
    label.className = "piano-key__label";
    key.append(label);
    return key;
  }

  /** Print the typing letters on whichever keys they currently reach. */
  private relabel(): void {
    const labels = labelsForBase(this.baseMidi);
    for (const [midi, element] of this.keys) {
      const label = element.querySelector<HTMLElement>(".piano-key__label");
      if (!label) continue;
      const text = labels.get(midi);
      label.textContent = text ?? (midi % 12 === 0 ? noteName(midi) : "");
      element.classList.toggle("has-binding", text !== undefined);
    }
  }

  setBase(base: number): void {
    const next = clampBaseMidi(base);
    if (next === this.baseMidi) return;
    // Release anything the old mapping is holding, or it hangs.
    for (const code of [...this.typed]) this.releaseTyped(code);
    this.baseMidi = next;
    this.keymap = keymapForBase(next);
    this.relabel();
  }

  // --- pointer ------------------------------------------------------------

  private midiAt(x: number, y: number): { midi: number; depth: number } | undefined {
    const element = document
      .elementsFromPoint(x, y)
      .find((node): node is HTMLElement => node instanceof HTMLElement && node.matches(".piano-key"));
    if (!element?.dataset.midi) return undefined;
    const rect = element.getBoundingClientRect();
    return { midi: Number(element.dataset.midi), depth: (y - rect.top) / rect.height };
  }

  private bindPointer(): void {
    const down = (event: PointerEvent) => {
      const hit = this.midiAt(event.clientX, event.clientY);
      if (!hit) return;
      event.preventDefault();
      this.callbacks.onGesture();
      // Releasing capture is what lets a finger or a held mouse button slide
      // from one key to the next — a glissando — instead of the first key
      // swallowing every later move event.
      if (this.root.hasPointerCapture?.(event.pointerId))
        this.root.releasePointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, hit.midi);
      this.press(hit.midi, velocityFromDepth(hit.depth));
    };

    const move = (event: PointerEvent) => {
      if (!this.pointers.has(event.pointerId)) return;
      const hit = this.midiAt(event.clientX, event.clientY);
      const current = this.pointers.get(event.pointerId);
      if (!hit) {
        if (current !== undefined) this.release(current);
        this.pointers.delete(event.pointerId);
        return;
      }
      if (hit.midi === current) return;
      if (current !== undefined) this.release(current);
      this.pointers.set(event.pointerId, hit.midi);
      this.press(hit.midi, velocityFromDepth(hit.depth));
    };

    const up = (event: PointerEvent) => {
      const midi = this.pointers.get(event.pointerId);
      if (midi === undefined) return;
      this.release(midi);
      this.pointers.delete(event.pointerId);
    };

    this.root.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    // Touch scroll must not drag the page out from under a held note.
    this.root.addEventListener("touchstart", (event) => event.preventDefault(), {
      passive: false,
    });
  }

  // --- computer keyboard --------------------------------------------------

  private bindKeyboard(): void {
    window.addEventListener("keydown", (event) => {
      if (isTextEntry(event.target)) return;

      // A focused button or slider keeps its own Space and arrows, or the
      // keyboard path through the controls stops working.
      const onControl = isControl(event.target);

      if (event.code === "Space") {
        if (onControl) return;
        event.preventDefault();
        if (!event.repeat) this.setSustain(true);
        this.callbacks.onGesture();
        return;
      }
      if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
        if (onControl || event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        this.setBase(this.baseMidi + (event.code === "ArrowRight" ? 12 : -12));
        return;
      }

      const midi = this.keymap.get(event.code);
      if (midi === undefined || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      if (event.repeat || this.typed.has(event.code)) return;
      this.callbacks.onGesture();
      this.typed.add(event.code);
      this.press(midi, TYPED_VELOCITY);
    });

    window.addEventListener("keyup", (event) => {
      if (event.code === "Space") {
        // Always lifts, even if focus moved onto a control mid-press.
        this.setSustain(false);
        return;
      }
      this.releaseTyped(event.code);
    });

    // A key held while the tab loses focus never gets its keyup.
    window.addEventListener("blur", () => this.allOff());
  }

  private releaseTyped(code: string): void {
    if (!this.typed.delete(code)) return;
    const midi = this.keymap.get(code);
    if (midi !== undefined) this.release(midi);
  }

  // --- sound and light ----------------------------------------------------

  private press(midi: number, velocity: number): void {
    if (this.held.has(midi)) this.release(midi);
    this.held.add(midi);
    this.keys.get(midi)?.classList.add("is-held");
    this.callbacks.onNoteOn(midi, velocity);
  }

  private release(midi: number): void {
    if (!this.held.delete(midi)) return;
    this.keys.get(midi)?.classList.remove("is-held");
    this.callbacks.onNoteOff(midi);
  }

  setSustain(down: boolean): void {
    if (this.sustaining === down) return;
    this.sustaining = down;
    this.root.classList.toggle("is-sustaining", down);
    this.callbacks.onSustain(down);
  }

  allOff(): void {
    for (const midi of [...this.held]) this.release(midi);
    this.typed.clear();
    this.pointers.clear();
    this.setSustain(false);
  }

  /** Light the keys a playing score is sounding, without touching held state. */
  setPlaybackLit(midis: Set<number>): void {
    for (const midi of this.litByPlayback) {
      if (!midis.has(midi)) this.keys.get(midi)?.classList.remove("is-lit");
    }
    for (const midi of midis) {
      if (!this.litByPlayback.has(midi)) this.keys.get(midi)?.classList.add("is-lit");
    }
    this.litByPlayback.clear();
    for (const midi of midis) this.litByPlayback.add(midi);
  }
}

/** Somewhere a letter key means a letter, so the piano must keep out. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA") return true;
  if (target instanceof HTMLInputElement) return !["range", "checkbox", "file"].includes(target.type);
  return false;
}

/** A focused widget with its own Space/arrow behaviour. */
function isControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return ["BUTTON", "INPUT", "SELECT", "A", "SUMMARY"].includes(target.tagName);
}
