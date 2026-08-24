// The note waterfall.
//
// Canvas, not DOM: a concerto here runs to 45,000 notes and one element each
// would be 45,000 elements the browser has to lay out. Instead only the notes
// inside the visible time window are painted, found by binary search each
// frame, so the cost of a frame depends on how much music is on screen and not
// on how long the piece is.

import { centresByMidi, keyLayout, LOWEST_MIDI, HIGHEST_MIDI } from "./piano/geometry.ts";
import { FAMILY_STYLES, type VisualNote } from "./midi/analysis.ts";

/** How far ahead of the playhead the screen looks, in score seconds. */
export const DEFAULT_LOOKAHEAD = 3.6;

export interface LiveNote {
  midi: number;
  /** Audio-context seconds. */
  start: number;
  /** Undefined while the key is still down. */
  end?: number;
  velocity: number;
}

export interface RenderInput {
  /** Score seconds — the transport clock. */
  time: number;
  /** Audio-context seconds, for live playing, which has no score. */
  liveTime: number;
  liveNotes: readonly LiveNote[];
  /** Conducting surface furniture, when conductor mode is on. */
  conductor?: {
    beatLine: number;
    trail: readonly { x: number; y: number }[];
    flash: number;
  };
}

const LIVE_FADE = 1.8; // seconds a released live note stays visible

/**
 * Where a note sits on the stage, in pixels from the top.
 *
 * This is the whole synchronisation contract, and it is two lines: a note's
 * bottom edge reaches the keybed exactly at its start time, and it enters at
 * the top exactly one lookahead earlier. Because `time` is score seconds and so
 * are `start` and `end`, this holds at any playback rate without the renderer
 * knowing what the rate is — and it is what makes the lead-in work, since a
 * time of `start - lookahead` puts the first note precisely at the top edge.
 */
export function notePosition(
  start: number,
  end: number,
  time: number,
  height: number,
  lookahead: number,
): { top: number; bottom: number } {
  const perSecond = height / lookahead;
  return {
    top: height - (end - time) * perSecond,
    bottom: height - (start - time) * perSecond,
  };
}

export class Waterfall {
  private readonly ctx: CanvasRenderingContext2D;
  private notes: readonly VisualNote[] = [];
  private maxNoteLength = 0;
  private width = 0;
  private height = 0;
  private readonly centres = centresByMidi();
  private readonly layout = keyLayout();

  lookahead = DEFAULT_LOOKAHEAD;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("This browser cannot give us a 2D canvas.");
    this.ctx = ctx;
    this.resize();
  }

  setNotes(notes: readonly VisualNote[]): void {
    this.notes = notes;
    this.maxNoteLength = notes.reduce((max, note) => Math.max(max, note.end - note.start), 0);
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Index of the first note that could still be on screen at `from`. */
  private firstVisible(from: number): number {
    const target = from - this.maxNoteLength;
    let low = 0;
    let high = this.notes.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.notes[mid].start < target) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  /**
   * Paint one frame. Returns the MIDI notes sounding right now, so the piano
   * can light the same keys the waterfall is landing on — one source of truth
   * for "what is playing", derived from the same clock.
   */
  render(input: RenderInput): Set<number> {
    const { ctx } = this;
    const w = this.width;
    const h = this.height;
    const sounding = new Set<number>();

    ctx.fillStyle = "#0b0d14";
    ctx.fillRect(0, 0, w, h);
    this.drawOctaveGuides();

    const from = input.time;
    const until = input.time + this.lookahead;

    for (let i = this.firstVisible(from); i < this.notes.length; i++) {
      const note = this.notes[i];
      if (note.start > until) break;
      if (note.end < from) continue;
      const centre = this.centres[note.midi];
      if (centre < 0) continue;

      const { top, bottom } = notePosition(note.start, note.end, input.time, h, this.lookahead);
      const style = FAMILY_STYLES[note.family];
      const active = note.start <= input.time && note.end > input.time;
      if (active) sounding.add(note.midi);
      this.drawNote(centre, top, bottom, note.midi, note.velocity, style, active, h);
    }

    this.drawLiveNotes(input);
    if (input.conductor) this.drawConductor(input.conductor);
    this.drawKeybed();
    return sounding;
  }

  private noteWidth(midi: number): number {
    const box = this.layout[midi - LOWEST_MIDI];
    const fraction = box ? box.width : 1 / 52;
    return Math.max(3, fraction * this.width * 0.86);
  }

  private drawNote(
    centre: number,
    top: number,
    bottom: number,
    midi: number,
    velocity: number,
    style: { fill: string; edge: string; glow: string },
    active: boolean,
    h: number,
  ): void {
    const { ctx } = this;
    const width = this.noteWidth(midi);
    const x = centre * this.width - width / 2;
    const y = Math.max(-40, top);
    const height = Math.max(3, Math.min(bottom, h + 20) - y);
    if (height <= 0) return;

    // Quieter notes sit back; louder ones come forward. The waterfall shows
    // dynamics as well as pitch, which is most of why these files sound alive.
    // The floor is high enough that a pianissimo still reads as a colour and
    // not as a grey smear — the family has to stay legible at any dynamic.
    const strength = 0.55 + (velocity / 127) * 0.45;
    ctx.globalAlpha = active ? 1 : strength;
    if (active) {
      ctx.shadowColor = style.glow;
      ctx.shadowBlur = 16;
    }
    ctx.fillStyle = active ? style.edge : style.fill;
    roundRect(ctx, x, y, width, height, Math.min(4, width / 2));
    ctx.fill();
    ctx.shadowBlur = 0;

    if (height > 6) {
      ctx.globalAlpha = active ? 0.9 : strength * 0.55;
      ctx.fillStyle = style.edge;
      roundRect(ctx, x, y, width, Math.min(3, height / 3), 1.5);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Live playing rises from the keybed rather than falling onto it, so the
   *  player's own notes never read as something the score asked for. */
  private drawLiveNotes(input: RenderInput): void {
    const { ctx } = this;
    const h = this.height;
    const pps = h / this.lookahead;
    for (const note of input.liveNotes) {
      const centre = this.centres[note.midi];
      if (centre < 0) continue;
      const end = note.end ?? input.liveTime;
      const age = input.liveTime - end;
      if (age > LIVE_FADE) continue;
      const width = this.noteWidth(note.midi);
      const x = centre * this.width - width / 2;
      const bottom = h - Math.max(0, age) * pps * 0.5;
      const top = bottom - Math.max(6, (end - note.start) * pps * 0.5) - 6;
      const fade = 1 - Math.max(0, age) / LIVE_FADE;
      ctx.globalAlpha = fade * (0.35 + (note.velocity / 127) * 0.65);
      ctx.shadowColor = "#ffe4b0";
      ctx.shadowBlur = 22 * fade;
      ctx.fillStyle = "#fff0d2";
      roundRect(ctx, x, top, width, bottom - top, Math.min(4, width / 2));
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }

  private drawOctaveGuides(): void {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.045)";
    ctx.lineWidth = 1;
    for (let midi = LOWEST_MIDI; midi <= HIGHEST_MIDI; midi++) {
      if (midi % 12 !== 0) continue;
      const x = Math.round(this.centres[midi] * this.width) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.height);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawKeybed(): void {
    const { ctx } = this;
    const gradient = ctx.createLinearGradient(0, this.height - 26, 0, this.height);
    gradient.addColorStop(0, "rgba(11,13,20,0)");
    gradient.addColorStop(1, "rgba(11,13,20,0.85)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, this.height - 26, this.width, 26);
    ctx.fillStyle = "rgba(255,214,153,0.5)";
    ctx.fillRect(0, this.height - 1.5, this.width, 1.5);
  }

  private drawConductor(conductor: NonNullable<RenderInput["conductor"]>): void {
    const { ctx } = this;
    const y = conductor.beatLine * this.height;

    ctx.save();
    ctx.strokeStyle = `rgba(255,214,153,${0.16 + conductor.flash * 0.6})`;
    ctx.lineWidth = 1 + conductor.flash * 2.5;
    ctx.setLineDash([14, 12]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(this.width, y);
    ctx.stroke();
    ctx.restore();

    const trail = conductor.trail;
    if (trail.length > 1) {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (let i = 1; i < trail.length; i++) {
        const strength = i / trail.length;
        ctx.strokeStyle = `rgba(255,229,190,${strength * 0.55})`;
        ctx.lineWidth = 1 + strength * 4;
        ctx.beginPath();
        ctx.moveTo(trail[i - 1].x * this.width, trail[i - 1].y * this.height);
        ctx.lineTo(trail[i].x * this.width, trail[i].y * this.height);
        ctx.stroke();
      }
      const tip = trail[trail.length - 1];
      ctx.fillStyle = "#fff3dc";
      ctx.shadowColor = "#ffcf7a";
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.arc(tip.x * this.width, tip.y * this.height, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
