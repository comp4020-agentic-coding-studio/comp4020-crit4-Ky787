// Transport: one sequencer, one loaded score, and the clock everything else
// reads from.
//
// The single most important property in here is that `time` is measured in
// SCORE seconds, not wall seconds. At a 1.5x conductor multiplier the score
// clock runs 1.5x faster than the wall clock, and note positions are score
// seconds too — so the waterfall cannot drift from the audio no matter what the
// conductor does. There is no second animation clock to keep in step.

import { Sequencer } from "spessasynth_lib";
import { BasicMIDI } from "spessasynth_core";
import type { AudioEngine } from "./audio/engine.ts";
import { extractNotes, referenceTempo, type VisualNote } from "./midi/analysis.ts";
import type { LoadedMIDI } from "./midi/library.ts";

export interface LoadedScore {
  midi: BasicMIDI;
  notes: VisualNote[];
  title: string;
  duration: number;
  /** True when the file carries more than one tempo — i.e. a real performance. */
  hasTempoMap: boolean;
  tempoChangeCount: number;
}

export class Transport {
  private readonly seq: Sequencer;
  score?: LoadedScore;

  onSongEnded?: () => void;

  constructor(private readonly engine: AudioEngine) {
    this.seq = new Sequencer(engine.synth, { skipToFirstNoteOn: true });
    this.seq.loopCount = 0;
    this.seq.eventHandler.addEvent("songEnded", "transport-ended", () => this.onSongEnded?.());
    this.seq.eventHandler.addEvent("songChange", "transport-song", () => {
      // A song load resets the synthesizer, which takes the player's own
      // channel with it.
      this.engine.ensureLiveChannel();
    });
  }

  /**
   * Parse and stage a score. Parsing happens here on the main thread from the
   * same bytes the sequencer gets, rather than round-tripping the parsed file
   * back out of the worklet.
   */
  async load(source: LoadedMIDI, { autoplay = false } = {}): Promise<LoadedScore> {
    const midi = BasicMIDI.fromArrayBuffer(source.binary.slice(0), source.fileName);
    const notes = extractNotes(midi);
    const tempos = new Set(midi.tempoChanges.map((change) => Math.round(change.tempo * 100)));
    const score: LoadedScore = {
      midi,
      notes,
      title: source.title,
      duration: midi.duration,
      hasTempoMap: tempos.size > 1,
      tempoChangeCount: midi.tempoChanges.length,
    };

    this.seq.loadNewSongList([{ binary: source.binary, fileName: source.fileName }]);
    this.seq.playbackRate = 1;
    if (!autoplay) this.seq.pause();
    this.score = score;
    return score;
  }

  get loaded(): boolean {
    return this.score !== undefined;
  }

  get playing(): boolean {
    return this.loaded && !this.seq.paused;
  }

  /**
   * Score seconds. Smoothed, so it is the one to draw with.
   *
   * Reading it advances the smoothing filter, so read it once per frame and
   * pass the value around — calling it three times in one frame triples the
   * filter's rate and quietly changes how it behaves.
   */
  get time(): number {
    return this.loaded ? this.seq.currentHighResolutionTime : 0;
  }

  get duration(): number {
    return this.score?.duration ?? 0;
  }

  /**
   * The tempo a listener would name at `seconds` — what the conductor is
   * measured against. Takes the time rather than reading the clock, so a caller
   * that already has this frame's time does not advance the filter again.
   */
  localTempoAt(seconds: number): number {
    return this.score ? referenceTempo(this.score.midi, seconds) : 120;
  }

  get rate(): number {
    return this.seq.playbackRate;
  }

  /** The conductor multiplier. Scales the tempo map; never replaces it. */
  set rate(value: number) {
    if (Math.abs(this.seq.playbackRate - value) < 1e-4) return;
    this.seq.playbackRate = value;
  }

  play(): void {
    if (!this.loaded) return;
    this.seq.play();
  }

  pause(): void {
    if (!this.loaded) return;
    this.seq.pause();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(seconds: number): void {
    if (!this.loaded) return;
    this.seq.currentTime = Math.max(0, Math.min(seconds, this.duration));
  }
}
