// Turning a parsed MIDI into what the waterfall and the conductor need:
// a flat, time-sorted note list coloured by orchestral family, and a local
// tempo the conductor can be measured against.

import type { BasicMIDI } from "spessasynth_core";

export type Family =
  | "piano"
  | "strings"
  | "woodwind"
  | "brass"
  | "percussion"
  | "voice"
  | "plucked"
  | "other";

export const DRUM_CHANNEL = 9;

/**
 * General MIDI program -> orchestral family. The families are the ones an
 * audience would name, not GM's own 16 groups: GM splits solo strings from
 * string ensembles and puts timpani in with the strings, which is no use for
 * telling a violin line from a horn line at a glance.
 */
export function familyForProgram(program: number, channel: number): Family {
  if (channel === DRUM_CHANNEL) return "percussion";
  if (program <= 7) return "piano"; // pianos, harpsichord, clav
  if (program <= 15) return "percussion"; // celesta, glockenspiel, tubular bells
  if (program <= 23) return "other"; // organs, accordion
  if (program <= 31) return "plucked"; // guitars
  if (program <= 39) return "plucked"; // basses
  if (program === 47) return "percussion"; // timpani
  if (program === 46) return "plucked"; // harp
  if (program <= 46) return "strings"; // violin..tremolo/pizz strings
  if (program <= 51) return "strings"; // string ensembles, synth strings
  if (program <= 54) return "voice"; // choir aahs, voice oohs, synth voice
  if (program === 55) return "brass"; // orchestra hit
  if (program <= 63) return "brass";
  if (program <= 79) return "woodwind"; // reeds and pipes
  if (program <= 103) return "other"; // synth lead/pad/fx
  if (program <= 111) return "other"; // ethnic
  if (program <= 119) return "percussion";
  return "other";
}

export interface FamilyStyle {
  fill: string;
  edge: string;
  glow: string;
  label: string;
}

/**
 * A concert palette: warm for the soloist, cool for the body of the orchestra,
 * so the piano line reads instantly against everything behind it.
 */
export const FAMILY_STYLES: Record<Family, FamilyStyle> = {
  piano: { fill: "#f6d9a4", edge: "#fff3dc", glow: "#ffcf7a", label: "Piano" },
  strings: { fill: "#6fc9d6", edge: "#c4f0f7", glow: "#5fd0e0", label: "Strings" },
  woodwind: { fill: "#95d67f", edge: "#d6f5c8", glow: "#8fdc74", label: "Woodwind" },
  brass: { fill: "#e8a355", edge: "#ffd7a6", glow: "#ff9f3d", label: "Brass" },
  percussion: { fill: "#e2718a", edge: "#ffc3cf", glow: "#ff6f8c", label: "Percussion" },
  voice: { fill: "#b198e8", edge: "#e2d6ff", glow: "#a889f0", label: "Voice" },
  plucked: { fill: "#7f9be0", edge: "#ccd9ff", glow: "#7591e8", label: "Plucked" },
  other: { fill: "#8d93a8", edge: "#c9cddb", glow: "#8d93a8", label: "Other" },
};

export interface VisualNote {
  midi: number;
  /** Seconds from the start of the score, at playback rate 1. */
  start: number;
  end: number;
  velocity: number;
  channel: number;
  family: Family;
}

interface ProgramChange {
  seconds: number;
  program: number;
}

/** Per-channel program-change timeline, in seconds, earliest first. */
function programTimeline(midi: BasicMIDI): Map<number, ProgramChange[]> {
  const byChannel = new Map<number, ProgramChange[]>();
  for (const track of midi.tracks) {
    for (const event of track.events) {
      if ((event.statusByte & 0xf0) !== 0xc0) continue;
      const channel = event.statusByte & 0x0f;
      const list = byChannel.get(channel) ?? [];
      list.push({ seconds: midi.midiTicksToSeconds(event.ticks), program: event.data[0] });
      byChannel.set(channel, list);
    }
  }
  for (const list of byChannel.values()) list.sort((a, b) => a.seconds - b.seconds);
  return byChannel;
}

function programAt(timeline: ProgramChange[] | undefined, seconds: number): number {
  if (!timeline || timeline.length === 0) return 0;
  let program = timeline[0].program;
  for (const change of timeline) {
    // A program change at tick 0 applies to a note at 0, so <= not <.
    if (change.seconds > seconds + 1e-6) break;
    program = change.program;
  }
  return program;
}

/**
 * Every note in the file as one time-sorted array. `getNoteTimes()` has already
 * walked the tempo map for us, so `start` and `end` are real seconds in the
 * score's own variable tempo — no BPM is assumed anywhere in here.
 */
export function extractNotes(midi: BasicMIDI): VisualNote[] {
  const timeline = programTimeline(midi);
  const perChannel = midi.getNoteTimes(0.06);
  const notes: VisualNote[] = [];
  for (let channel = 0; channel < perChannel.length; channel++) {
    const channelTimeline = timeline.get(channel);
    for (const note of perChannel[channel]) {
      const program = programAt(channelTimeline, note.start);
      notes.push({
        midi: note.midiNote,
        start: note.start,
        end: note.start + Math.max(note.length, 0.03),
        velocity: note.velocity,
        channel,
        family: familyForProgram(program, channel),
      });
    }
  }
  notes.sort((a, b) => a.start - b.start);
  return notes;
}

/** The families actually present, in the order they should be shown. */
export function familiesPresent(notes: readonly VisualNote[]): Family[] {
  const order: Family[] = [
    "piano",
    "strings",
    "woodwind",
    "brass",
    "percussion",
    "voice",
    "plucked",
    "other",
  ];
  const seen = new Set(notes.map((note) => note.family));
  return order.filter((family) => seen.has(family));
}

/**
 * How long a window the conductor's tempo is measured against. The supplied
 * performances carry 1300-2600 tempo events with instantaneous values from 5 to
 * 480 BPM, so `sequencer.currentTempo` on its own is unusable as a baseline —
 * dividing the player's beat rate by a spike would swing the multiplier from
 * 0.4x to 2.0x between one beat and the next. Averaging over a window gives the
 * tempo a listener would actually name, and leaves the rubato inside the window
 * for the tempo map to express.
 */
export const REFERENCE_WINDOW_SECONDS = 8;

export const MIN_REFERENCE_TEMPO = 30;
export const MAX_REFERENCE_TEMPO = 300;

/**
 * The score's local tempo in BPM: beats elapsed across a window centred on
 * `seconds`, divided by the window. Exact, because the tick<->second mapping is
 * the tempo map itself.
 */
export function referenceTempo(
  midi: Pick<BasicMIDI, "secondsToMIDITicks" | "timeDivision" | "duration">,
  seconds: number,
  windowSeconds: number = REFERENCE_WINDOW_SECONDS,
): number {
  const half = windowSeconds / 2;
  const from = Math.max(0, Math.min(seconds - half, Math.max(0, midi.duration - windowSeconds)));
  const to = from + windowSeconds;
  const beats = (midi.secondsToMIDITicks(to) - midi.secondsToMIDITicks(from)) / midi.timeDivision;
  const bpm = (beats * 60) / windowSeconds;
  if (!Number.isFinite(bpm) || bpm <= 0) return 120;
  return Math.min(MAX_REFERENCE_TEMPO, Math.max(MIN_REFERENCE_TEMPO, bpm));
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}
