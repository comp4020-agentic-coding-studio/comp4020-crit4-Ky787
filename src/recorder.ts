// Recording a live performance.
//
// The recording is written out as a real Standard MIDI File and handed back to
// the transport like any other score. That is the whole reason it is worth
// doing this way: playback, the falling notes, and conductor mode all work on a
// recording without a line of special-case code.

import { MIDIBuilder, MIDIControllers } from "spessasynth_core";

/** 500 ticks per quarter at 120 BPM puts one tick at one millisecond. */
export const TICKS_PER_QUARTER = 500;
export const RECORDING_TEMPO = 120;
const TICKS_PER_SECOND = (TICKS_PER_QUARTER * RECORDING_TEMPO) / 60; // 1000

export type RecordedEvent =
  | { kind: "on"; time: number; midi: number; velocity: number }
  | { kind: "off"; time: number; midi: number }
  | { kind: "sustain"; time: number; down: boolean };

export interface Recording {
  events: RecordedEvent[];
  /** Seconds. */
  length: number;
  program: number;
}

function toTicks(seconds: number): number {
  return Math.max(0, Math.round(seconds * TICKS_PER_SECOND));
}

/**
 * Write a performance out as a type-1 SMF. Velocity, note length and the
 * sustain pedal all survive, which is what makes a played-back recording sound
 * like the performance rather than a transcription of it.
 */
export function buildRecordingMIDI(recording: Recording, name: string): ArrayBuffer {
  const builder = new MIDIBuilder({
    timeDivision: TICKS_PER_QUARTER,
    initialTempo: RECORDING_TEMPO,
    format: 1,
    name,
  });
  builder.addTrack(name);
  const track = builder.tracks.length - 1;
  builder.programChange(0, track, 0, recording.program);

  const sorted = [...recording.events].sort((a, b) => a.time - b.time);
  for (const event of sorted) {
    const ticks = toTicks(event.time);
    if (event.kind === "on") builder.noteOn(ticks, track, 0, event.midi, event.velocity);
    else if (event.kind === "off") builder.noteOff(ticks, track, 0, event.midi);
    else
      builder.controllerChange(
        ticks,
        track,
        0,
        MIDIControllers.sustainPedal,
        event.down ? 127 : 0,
      );
  }

  // Without a tail event the file ends on the last note-off and the sequencer
  // reports the song over while the pedal is still ringing.
  builder.controllerChange(
    toTicks(recording.length + 1.5),
    track,
    0,
    MIDIControllers.sustainPedal,
    0,
  );
  builder.flush(true);
  return builder.writeMIDI();
}

export class Recorder {
  private events: RecordedEvent[] = [];
  private startedAt = 0;
  private recording = false;
  private held = new Set<number>();

  /** Program the live keyboard was using, so playback sounds the same. */
  program = 0;

  get isRecording(): boolean {
    return this.recording;
  }

  get noteCount(): number {
    return this.events.filter((event) => event.kind === "on").length;
  }

  get elapsed(): number {
    return this.recording ? this.now() - this.startedAt : 0;
  }

  constructor(private readonly now: () => number) {}

  start(): void {
    this.events = [];
    this.held.clear();
    this.startedAt = this.now();
    this.recording = true;
  }

  /** Returns the finished performance, or undefined if nothing was played. */
  stop(): Recording | undefined {
    if (!this.recording) return undefined;
    const length = this.elapsed;
    // Anything still held when the player hits stop is closed off here rather
    // than dropped, so a note held through the stop still has a length.
    for (const midi of this.held) this.events.push({ kind: "off", time: length, midi });
    this.held.clear();
    this.recording = false;
    if (this.noteCount === 0) return undefined;
    return { events: this.events, length, program: this.program };
  }

  cancel(): void {
    this.recording = false;
    this.events = [];
    this.held.clear();
  }

  noteOn(midi: number, velocity: number): void {
    if (!this.recording) return;
    this.events.push({ kind: "on", time: this.elapsed, midi, velocity });
    this.held.add(midi);
  }

  noteOff(midi: number): void {
    if (!this.recording) return;
    this.events.push({ kind: "off", time: this.elapsed, midi });
    this.held.delete(midi);
  }

  sustain(down: boolean): void {
    if (!this.recording) return;
    this.events.push({ kind: "sustain", time: this.elapsed, down });
  }
}
