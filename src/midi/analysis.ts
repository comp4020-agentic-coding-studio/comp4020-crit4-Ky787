// Turning a parsed MIDI into what the waterfall and the conductor need:
// a flat, time-sorted note list coloured by orchestral family, and a local
// tempo the conductor can be measured against.

import type { BasicMIDI } from "spessasynth_core";

export type Family =
  | "piano"
  | "strings"
  | "woodwind"
  | "flute"
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
  // The oboe is a reed, but it sits with the flutes here on purpose: what the
  // colour has to do is separate the two lines an ear separates, and in this
  // repertoire the flute and oboe are the pair that trade the top line.
  if (program === 68) return "flute";
  if (program <= 71) return "woodwind"; // saxes, english horn, bassoon, clarinet
  if (program <= 79) return "flute"; // piccolo, flute, recorder, pan pipes
  if (program <= 103) return "other"; // synth lead/pad/fx
  if (program <= 111) return "other"; // ethnic
  if (program <= 119) return "percussion";
  return "other";
}

export interface FamilyStyle {
  /** The body of a note that has not sounded yet. */
  fill: string;
  /** The thin highlight along a note's top edge. */
  edge: string;
  /** The body of a note while it is sounding: brighter, but still the family's
   *  own hue. Washing it to near-white loses the colour at the one moment the
   *  note most needs to be identifiable. */
  lit: string;
  /** What the note casts onto the dark behind it while sounding. */
  glow: string;
  label: string;
}

/**
 * One saturated hue per section, so a line can be picked out of a tutti at a
 * glance. `edge` is the lit top of a note and the colour it takes while it is
 * sounding; `glow` is what it casts onto the dark behind it.
 *
 * The hues are spread around the wheel rather than shaded within a family,
 * because the job is telling sections apart, not showing that they are related.
 * The piano is blue and alone in that corner of the wheel: it is the soloist,
 * and it has to stay findable under a full orchestra.
 */
export const FAMILY_STYLES: Record<Family, FamilyStyle> = {
  piano: { fill: "#3d9bff", edge: "#c9e4ff", lit: "#8ec9ff", glow: "#2b8bff", label: "Piano" },
  strings: { fill: "#ff4256", edge: "#ffc4cb", lit: "#ff8791", glow: "#ff2038", label: "Strings" },
  brass: { fill: "#ff9614", edge: "#ffdcab", lit: "#ffbe63", glow: "#ff8400", label: "Brass" },
  woodwind: { fill: "#ffe03d", edge: "#fff6b8", lit: "#ffee85", glow: "#ffd400", label: "Woodwind" },
  flute: { fill: "#2fd968", edge: "#bcf7d1", lit: "#79eba1", glow: "#12c94f", label: "Flute & oboe" },
  percussion: {
    fill: "#a855f7",
    edge: "#e4c9ff",
    lit: "#c795fb",
    glow: "#9333ea",
    label: "Timpani & drums",
  },
  voice: { fill: "#ff5fd2", edge: "#ffcaf0", lit: "#ff9ae2", glow: "#f43fbf", label: "Voice" },
  plucked: { fill: "#1fd6ee", edge: "#b6f3fb", lit: "#77e8f7", glow: "#06bcd4", label: "Plucked" },
  other: { fill: "#98a2ba", edge: "#d2d8e6", lit: "#bcc3d2", glow: "#98a2ba", label: "Other" },
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
    "brass",
    "woodwind",
    "flute",
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
