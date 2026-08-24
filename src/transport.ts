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

/**
 * The lead-in: the stretch of score time before the first note, played out on
 * the app's own clock while the sequencer waits.
 *
 * It buys two things. The first note falls the whole height of the screen
 * instead of appearing on the keybed the instant you press play, which is what
 * a piece starting is supposed to look like. And it hides the cost of getting
 * going — parsing a 45,000-note concerto blocks the main thread for about
 * 150 ms, and the synthesizer thread is still preloading voices — behind
 * something that is deliberately quiet anyway.
 */
interface LeadIn {
  /** Score seconds at the top of the screen. Usually negative. */
  from: number;
  /** Score seconds of the first note: where the sequencer takes over. */
  to: number;
  elapsed: number;
  running: boolean;
  lastNow: number;
}

const now = (): number => performance.now() / 1000;

export class Transport {
  private readonly seq: Sequencer;
  score?: LoadedScore;
  private lead?: LeadIn;

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
  async load(
    source: LoadedMIDI,
    { autoplay = false, leadIn = 0 } = {},
  ): Promise<LoadedScore> {
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
    this.seq.pause();
    this.lead = undefined;
    this.score = score;
    if (autoplay) this.startWithLeadIn(leadIn);
    return score;
  }

  /**
   * Run `seconds` of score time up to the first note on our own clock, then
   * hand over to the sequencer.
   *
   * The seek happens now, not at the handover: the sequencer's clock lives on
   * another thread and a `timeChange` has to come back before `play()` resumes
   * from the right place. Seconds of lead-in is more than enough for that round
   * trip, so the join is silent.
   */
  private startWithLeadIn(seconds: number): void {
    if (!this.score) return;
    const firstNote = this.score.notes[0]?.start ?? 0;
    this.seq.currentTime = firstNote;
    if (seconds <= 0) {
      this.seq.play();
      return;
    }
    this.lead = {
      from: firstNote - seconds,
      to: firstNote,
      elapsed: 0,
      running: true,
      lastNow: now(),
    };
  }

  get isLeadingIn(): boolean {
    return this.lead !== undefined;
  }

  /**
   * Advance the clock and return this frame's score time. Call exactly once per
   * frame: it both reads the smoothed sequencer clock (which advances its own
   * filter on read) and is where the lead-in hands over to playback.
   */
  tick(): number {
    if (!this.loaded) return 0;
    const lead = this.lead;
    if (!lead) return this.seq.currentHighResolutionTime;

    if (lead.running) {
      const at = now();
      lead.elapsed += at - lead.lastNow;
      lead.lastNow = at;
    }
    const time = lead.from + lead.elapsed;
    if (lead.running && time >= lead.to) {
      this.lead = undefined;
      this.seq.play();
      return lead.to;
    }
    return Math.min(time, lead.to);
  }

  get loaded(): boolean {
    return this.score !== undefined;
  }

  get playing(): boolean {
    if (!this.loaded) return false;
    // A lead-in is playing — it is the opening of the piece, just a silent
    // part of it — so the pause button has to say so.
    return this.lead ? this.lead.running : !this.seq.paused;
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
    if (this.lead) {
      // Resume the lead-in where it stopped rather than restarting it, so
      // pausing during the opening is not a way to replay the opening.
      this.lead.running = true;
      this.lead.lastNow = now();
      return;
    }
    this.seq.play();
  }

  pause(): void {
    if (!this.loaded) return;
    if (this.lead) {
      this.lead.running = false;
      return;
    }
    this.seq.pause();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Scrubbing means you have somewhere else in mind; the lead-in is over. */
  seek(seconds: number): void {
    if (!this.loaded) return;
    const resume = this.lead?.running ?? false;
    this.lead = undefined;
    this.seq.currentTime = Math.max(0, Math.min(seconds, this.duration));
    if (resume) this.seq.play();
  }
}
