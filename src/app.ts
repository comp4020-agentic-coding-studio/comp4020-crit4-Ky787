// Wiring. Everything below owns co-ordination only: the audio, the score, the
// piano, the waterfall and the conductor each know their own job and none of
// them know about each other.

import { AudioEngine, LIVE_CHANNEL } from "./audio/engine.ts";
import { Transport, type LoadedScore } from "./transport.ts";
import { Piano } from "./piano/keyboard.ts";
import { Waterfall, type LiveNote } from "./visualizer.ts";
import { Panel, type Setting } from "./ui/panel.ts";
import { Recorder, buildRecordingMIDI } from "./recorder.ts";
import {
  applyBeat,
  BatonTracker,
  ICTUS_LINE,
  initialConductorState,
  relax,
  type ConductorState,
} from "./conductor.ts";
import {
  FAMILY_STYLES,
  familiesPresent,
  formatTime,
  type Family,
} from "./midi/analysis.ts";
import {
  fetchPiece,
  looksLikeMIDI,
  readLocalMIDI,
  REPERTOIRE,
  type LoadedMIDI,
  type Piece,
} from "./midi/library.ts";

type Mode = "play" | "conduct";

const SUSTAIN_CC = 64;

function need<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as unknown as T;
}

/** The readouts update 60 times a second and change perhaps twice; writing
 *  textContent regardless is layout work for nothing. */
function setText(element: Element, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

export class App {
  private readonly root = need<HTMLElement>("app");
  private readonly stage = need<HTMLElement>("stage");
  private readonly canvas = need<HTMLCanvasElement>("waterfall");
  private readonly statusLine = need<HTMLElement>("status");
  private readonly titleLine = need<HTMLElement>("title");
  private readonly timeLine = need<HTMLElement>("time");
  private readonly tempoLine = need<HTMLElement>("tempo");
  private readonly scrub = need<HTMLInputElement>("scrub");
  private readonly playButton = need<HTMLButtonElement>("play");
  private readonly recordButton = need<HTMLButtonElement>("record");
  private readonly takeButton = need<HTMLButtonElement>("play-take");
  private readonly recordLabel = need<HTMLElement>("record-label");
  private readonly modePlay = need<HTMLButtonElement>("mode-play");
  private readonly modeConduct = need<HTMLButtonElement>("mode-conduct");
  private readonly conductHud = need<HTMLElement>("conduct-hud");
  private readonly conductPrompt = need<HTMLElement>("conduct-prompt");
  private readonly conductMultiplier = need<HTMLElement>("conduct-multiplier");
  private readonly conductTempo = need<HTMLElement>("conduct-tempo");
  private readonly legend = need<HTMLElement>("legend");
  private readonly dropHint = need<HTMLElement>("drop-hint");
  private readonly panelElement = need<HTMLElement>("panel");
  private readonly panelToggle = need<HTMLButtonElement>("panel-toggle");

  private readonly engine = new AudioEngine();
  private readonly waterfall = new Waterfall(this.canvas);
  private readonly recorder = new Recorder(() => this.engine.context.currentTime);
  private readonly baton = new BatonTracker(ICTUS_LINE);

  private transport!: Transport;
  private piano!: Piano;
  private panel!: Panel;

  private mode: Mode = "play";
  private conductorState: ConductorState = initialConductorState();
  private conducting = false;
  private beatFlash = 0;
  private lastFrame = 0;
  private scrubbing = false;
  private hasTake = false;
  private takeMIDI?: LoadedMIDI;
  private liveNotes: LiveNote[] = [];
  private readonly liveHeld = new Map<number, LiveNote>();
  private manualRate = 1;
  private lastStatus = "";
  private statusTimer = 0;
  /** This frame's score time, so nothing reads the smoothed clock twice. */
  private frameTime = 0;
  private lastRatePush = 0;
  private loadingScore = false;
  private playButtonShows?: boolean;

  /** For the browser checks and the console: see main.ts. */
  get audio(): AudioEngine {
    return this.engine;
  }

  get score(): Transport | undefined {
    return this.transport;
  }

  // --- boot ---------------------------------------------------------------

  async start(): Promise<void> {
    this.buildRepertoire();
    this.bindDragAndDrop();
    this.bindResize();

    // The piano and the frame loop come up before the sound bank does, so the
    // page is already an instrument-shaped thing while it loads.
    this.piano = new Piano(need<HTMLElement>("piano"), {
      onNoteOn: (midi, velocity) => this.liveNoteOn(midi, velocity),
      onNoteOff: (midi) => this.liveNoteOff(midi),
      onSustain: (down) => this.liveSustain(down),
      onTransport: () => {
        if (!this.transport?.loaded) return;
        this.transport.toggle();
        this.refreshPlayButton();
      },
      onGesture: () => void this.wake(),
    });
    requestAnimationFrame((t) => this.frame(t));

    const fill = need<HTMLElement>("boot-fill");
    try {
      await this.engine.init((loaded, total) => {
        fill.style.width = `${Math.round((loaded / total) * 100)}%`;
      });
    } catch (error) {
      this.root.dataset.state = "error";
      this.setStatus(
        `The sound bank did not load (${error instanceof Error ? error.message : "unknown error"}). Reload to try again.`,
        true,
      );
      return;
    }

    this.transport = new Transport(this.engine);
    this.transport.onSongEnded = () => this.onSongEnded();
    this.buildPanel();
    this.bindTransport();
    this.bindModes();
    this.bindConductor();
    this.applyLiveProgram();

    this.root.dataset.state = "ready";
    fill.style.width = "100%";
  }

  private async wake(): Promise<void> {
    await this.engine.resume();
    this.root.dataset.played = "true";
  }

  // --- live piano ---------------------------------------------------------

  private applyLiveProgram(): void {
    this.engine.ensureLiveChannel();
    this.engine.synth.programChange(LIVE_CHANNEL, this.recorder.program);
  }

  private liveNoteOn(midi: number, velocity: number): void {
    if (!this.engine.isReady) return;
    this.engine.synth.noteOn(LIVE_CHANNEL, midi, velocity);
    this.recorder.noteOn(midi, velocity);
    const note: LiveNote = { midi, start: this.engine.context.currentTime, velocity };
    this.liveHeld.set(midi, note);
    this.liveNotes.push(note);
    if (this.liveNotes.length > 220) this.liveNotes.shift();
  }

  private liveNoteOff(midi: number): void {
    if (!this.engine.isReady) return;
    this.engine.synth.noteOff(LIVE_CHANNEL, midi);
    this.recorder.noteOff(midi);
    const note = this.liveHeld.get(midi);
    if (note) {
      note.end = this.engine.context.currentTime;
      this.liveHeld.delete(midi);
    }
  }

  private liveSustain(down: boolean): void {
    if (!this.engine.isReady) return;
    this.engine.synth.controllerChange(LIVE_CHANNEL, SUSTAIN_CC, down ? 127 : 0);
    this.recorder.sustain(down);
  }

  // --- repertoire ---------------------------------------------------------

  private buildRepertoire(): void {
    const list = need<HTMLElement>("repertoire-list");
    for (const piece of REPERTOIRE) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chip";
      button.dataset.piece = piece.id;
      button.title = piece.note;
      const composer = document.createElement("strong");
      composer.textContent = piece.composer;
      button.append(composer, ` · ${piece.short}`);
      button.addEventListener("click", (event) => {
        // A mouse click leaves focus sitting on the chip. Space is the
        // transport key and already refuses to activate a focused control, but
        // a stray Enter would still reload the piece, so hand focus back after
        // a pointer click. `detail` is 0 for keyboard activation, where moving
        // focus would strand a keyboard user.
        if (event.detail > 0) button.blur();
        void this.choosePiece(piece, button);
      });
      item.append(button);
      list.append(item);
    }

    need<HTMLInputElement>("file-input").addEventListener("change", (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) void this.loadFile(file);
    });
  }

  private markChosen(active?: HTMLElement): void {
    for (const chip of document.querySelectorAll<HTMLElement>("[data-piece]"))
      chip.classList.toggle("is-on", chip === active);
  }

  private async choosePiece(piece: Piece, button: HTMLElement): Promise<void> {
    await this.wake();
    this.markChosen(button);
    this.setStatus(`Loading ${piece.composer} — ${piece.title}…`);
    try {
      await this.loadScore(await fetchPiece(piece), true);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : "That file would not load.", true);
    }
  }

  private async loadFile(file: File): Promise<void> {
    await this.wake();
    if (!looksLikeMIDI(file)) {
      this.setStatus(`${file.name} does not look like a MIDI file.`, true);
      return;
    }
    this.markChosen();
    try {
      // Read in the page. Nothing leaves the browser.
      await this.loadScore(await readLocalMIDI(file), true);
    } catch (error) {
      this.setStatus(
        `${file.name} could not be read as MIDI${error instanceof Error ? `: ${error.message}` : ""}.`,
        true,
      );
    }
  }

  private async loadScore(source: LoadedMIDI, autoplay: boolean): Promise<void> {
    // Two loads at once would interleave a parse with a sequencer swap.
    if (this.loadingScore) return;
    this.loadingScore = true;
    // Parsing a concerto blocks the main thread for ~150 ms, so let the browser
    // paint the "loading" state first. Otherwise the click appears to do
    // nothing until the music is already underway.
    this.root.dataset.state = "loading-score";
    await new Promise((resolve) => requestAnimationFrame(resolve));

    let score: LoadedScore;
    try {
      score = await this.transport.load(source, {
        autoplay,
        // Start the clock a full screen's worth of time before the first note,
        // so the piece arrives from the top of the stage, not on the keybed.
        leadIn: this.waterfall.lookahead,
      });
    } finally {
      // A file that fails to parse must not leave the loader wedged shut.
      this.root.dataset.state = "ready";
      this.loadingScore = false;
    }

    this.waterfall.setNotes(score.notes);
    this.resetConductor();
    this.transport.rate = this.manualRate;
    this.titleLine.textContent = score.title;
    this.titleLine.title = score.title;
    this.scrub.disabled = false;
    this.playButton.disabled = false;
    this.modeConduct.disabled = false;
    this.modeConduct.title = "Shape this performance with your hand";
    this.buildLegend(score);
    this.setStatus(this.describeScore(score));
    this.applyLiveProgram();
    // Loading a piece lands you in Conduct. Conducting is the thing this page
    // does that a MIDI player does not, and having to find a button before you
    // can do it made it read as an extra rather than as the point. The piano is
    // one click away and still plays under your hands in either mode.
    if (autoplay) this.setMode("conduct");
    this.refreshPlayButton();
  }

  private describeScore(score: LoadedScore): string {
    const notes = score.notes.length.toLocaleString("en-AU");
    if (!score.hasTempoMap) return `${notes} notes · one fixed tempo`;
    return `${notes} notes · ${score.tempoChangeCount.toLocaleString("en-AU")} tempo changes, played as written`;
  }

  private buildLegend(score: LoadedScore): void {
    this.legend.innerHTML = "";
    for (const family of familiesPresent(score.notes)) {
      const style = FAMILY_STYLES[family as Family];
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = style.fill;
      const item = document.createElement("li");
      item.append(swatch, style.label);
      this.legend.append(item);
    }
  }

  // --- transport ----------------------------------------------------------

  private bindTransport(): void {
    this.playButton.addEventListener("click", () => {
      void this.wake();
      this.transport.toggle();
      this.refreshPlayButton();
    });

    this.scrub.addEventListener("pointerdown", () => {
      this.scrubbing = true;
    });
    const endScrub = () => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      this.transport.seek((Number(this.scrub.value) / 1000) * this.transport.duration);
    };
    this.scrub.addEventListener("pointerup", endScrub);
    this.scrub.addEventListener("change", endScrub);
    this.scrub.addEventListener("keydown", () => {
      this.scrubbing = true;
    });

    this.recordButton.addEventListener("click", () => void this.toggleRecording());
    this.takeButton.addEventListener("click", () => void this.playTake());
  }

  private refreshPlayButton(): void {
    const playing = this.transport?.playing ?? false;
    if (playing === this.playButtonShows) return;
    this.playButtonShows = playing;
    this.playButton.classList.toggle("is-playing", playing);
    this.playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
    // Where the space binding gets discovered, since the opening screen has no
    // room to teach a key that only matters once something is loaded.
    this.playButton.title = playing ? "Pause (space)" : "Play (space)";
    const glyph = this.playButton.querySelector(".round__glyph");
    if (glyph) glyph.textContent = playing ? "❚❚" : "▶";
  }

  private onSongEnded(): void {
    this.refreshPlayButton();
    this.resetConductor();
  }

  // --- recording ----------------------------------------------------------

  private async toggleRecording(): Promise<void> {
    await this.wake();
    if (!this.recorder.isRecording) {
      this.recorder.start();
      this.recordButton.classList.add("is-recording");
      this.recordLabel.textContent = "Stop";
      this.setStatus("Recording. Play — pedal and touch are captured too.");
      return;
    }

    const take = this.recorder.stop();
    this.recordButton.classList.remove("is-recording");
    this.recordLabel.textContent = "Record";
    if (!take) {
      this.setStatus("Nothing was played, so there is no take to keep.");
      return;
    }

    // Written out as a real MIDI file so a take goes through exactly the same
    // pipeline a concerto does — waterfall, transport and conductor included.
    const binary = buildRecordingMIDI(take, "My take");
    this.takeMIDI = { binary, fileName: "my-take.mid", title: "My take" };
    this.hasTake = true;
    this.takeButton.disabled = false;
    this.setStatus(
      `Take kept: ${take.events.filter((event) => event.kind === "on").length} notes over ${formatTime(take.length)}. Conduct it if you like.`,
    );
  }

  private async playTake(): Promise<void> {
    if (!this.hasTake || !this.takeMIDI) return;
    await this.wake();
    this.markChosen();
    // A fresh copy: loading transfers the bytes to the sequencer's thread.
    await this.loadScore({ ...this.takeMIDI, binary: this.takeMIDI.binary.slice(0) }, true);
  }

  // --- modes --------------------------------------------------------------

  private bindModes(): void {
    this.modePlay.addEventListener("click", () => this.setMode("play"));
    this.modeConduct.addEventListener("click", () => this.setMode("conduct"));

    this.panelToggle.addEventListener("click", () => {
      const open = this.panelElement.hasAttribute("hidden");
      this.panelElement.toggleAttribute("hidden", !open);
      this.panelToggle.setAttribute("aria-expanded", String(open));
      this.panelToggle.classList.toggle("is-on", open);
    });
  }

  private setMode(mode: Mode): void {
    if (mode === "conduct" && !this.transport?.loaded) return;
    this.mode = mode;
    this.root.dataset.mode = mode;
    this.modePlay.classList.toggle("is-on", mode === "play");
    this.modeConduct.classList.toggle("is-on", mode === "conduct");
    this.modePlay.setAttribute("aria-pressed", String(mode === "play"));
    this.modeConduct.setAttribute("aria-pressed", String(mode === "conduct"));
    this.conductHud.toggleAttribute("hidden", mode !== "conduct");
    this.conductPrompt.toggleAttribute("hidden", mode !== "conduct");

    if (mode === "conduct") {
      // Switching modes must never move the playhead: the mode is a way of
      // touching the same performance, not a different performance.
      if (!this.transport.playing) this.transport.play();
      this.refreshPlayButton();
    } else if (this.transport?.loaded) {
      this.endConducting();
      // Leave the music where the hand left it, and hand the slider the same
      // number, so the two controls never disagree about the current tempo.
      this.manualRate = Number(this.conductorState.multiplier.toFixed(2));
      this.panel?.reflect("tempo", this.manualRate);
      this.engine.setDynamic(this.dynamicsSetting);
      this.setStatus("");
    }
  }

  // --- conducting ---------------------------------------------------------

  private bindConductor(): void {
    const sample = (event: PointerEvent): void => {
      if (this.mode !== "conduct") return;
      const rect = this.stage.getBoundingClientRect();
      const point = {
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
        t: performance.now() / 1000,
      };
      const beat = this.baton.push(point);
      if (!beat) return;
      this.conductorState = applyBeat(
        this.conductorState,
        beat,
        this.transport.localTempoAt(this.frameTime),
        point.t,
      );
      this.beatFlash = 1;
    };

    this.stage.addEventListener("pointerdown", (event) => {
      if (this.mode !== "conduct") return;
      event.preventDefault();
      void this.wake();
      this.conducting = true;
      this.root.dataset.conducting = "true";
      this.stage.setPointerCapture(event.pointerId);
      this.baton.reset();
      sample(event);
    });

    this.stage.addEventListener("pointermove", (event) => {
      if (!this.conducting) return;
      // Coalesced events give the baton its real path on a high-rate pointer,
      // so a fast downbeat is not reduced to one straight line.
      const points = event.getCoalescedEvents?.() ?? [];
      for (const point of points.length ? points : [event]) sample(point);
    });

    const stop = (event: PointerEvent) => {
      if (!this.conducting) return;
      if (this.stage.hasPointerCapture(event.pointerId))
        this.stage.releasePointerCapture(event.pointerId);
      this.endConducting();
    };
    this.stage.addEventListener("pointerup", stop);
    this.stage.addEventListener("pointercancel", stop);
  }

  private endConducting(): void {
    this.conducting = false;
    delete this.root.dataset.conducting;
    this.baton.reset();
  }

  private resetConductor(): void {
    this.conductorState = initialConductorState();
    this.engine.setDynamic(1);
    if (this.transport) this.transport.rate = this.manualRate;
  }

  // --- frame loop ---------------------------------------------------------

  private frame(now: number): void {
    requestAnimationFrame((next) => this.frame(next));
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0.016;
    this.lastFrame = now;
    this.beatFlash = Math.max(0, this.beatFlash - dt * 4);

    // Drives the transport's clock, and is where a lead-in hands over to
    // playback. Exactly once per frame; see Transport.tick.
    const time = this.transport?.tick() ?? 0;
    this.frameTime = time;
    if (this.transport?.loaded && this.mode === "conduct") this.updateConductor(dt);

    const sounding = this.waterfall.render({
      time,
      liveTime: this.engine.context.currentTime,
      liveNotes: this.liveNotes,
      conductor:
        this.mode === "conduct"
          ? {
              beatLine: ICTUS_LINE,
              trail: this.baton.trail,
              flash: this.beatFlash,
              // The swing in progress, so the surface can show the dynamic the
              // player is winding up to before the beat lands.
              lift: this.baton.lift,
              ictusX: this.baton.ictusX,
            }
          : undefined,
    });
    this.piano?.setPlaybackLit(sounding);
    this.pruneLiveNotes();
    this.updateReadouts(time);
  }

  private updateConductor(dt: number): void {
    const nowSeconds = performance.now() / 1000;
    this.conductorState = relax(this.conductorState, nowSeconds, dt);

    // The multiplier scales the score's own tempo map. What the sequencer plays
    // at any instant is still the tempo the performer chose there, times this.
    // Pushed at 20 Hz rather than every frame: each change is a message to the
    // synthesizer thread, and tempo steps this small are inaudible anyway.
    if (nowSeconds - this.lastRatePush > 0.05) {
      this.lastRatePush = nowSeconds;
      this.transport.rate = this.conductorState.multiplier;
    }

    this.engine.setDynamic(
      this.conductorState.dynamic * (1 + this.conductorState.accent) * this.dynamicsSetting,
    );
    this.panel?.reflect("tempo", Number(this.conductorState.multiplier.toFixed(2)));
  }

  private get dynamicsSetting(): number {
    return this.panel ? this.panel.read("dynamics") : 1;
  }

  private pruneLiveNotes(): void {
    if (this.liveNotes.length < 40) return;
    const cutoff = this.engine.context.currentTime - 4;
    this.liveNotes = this.liveNotes.filter((note) => (note.end ?? Infinity) > cutoff);
  }

  private updateReadouts(time: number): void {
    if (!this.transport?.loaded) {
      setText(this.tempoLine, "");
      return;
    }
    const duration = this.transport.duration;
    setText(this.timeLine, `${formatTime(time)} / ${formatTime(duration)}`);
    if (!this.scrubbing && duration > 0) {
      // Lead-in time is negative; the slider's own floor is 0, so clamp here or
      // it disagrees with what we wrote and we rewrite it every frame.
      const position = String(Math.max(0, Math.round((time / duration) * 1000)));
      if (this.scrub.value !== position) this.scrub.value = position;
    }

    const local = this.transport.localTempoAt(time);
    const rate = this.transport.rate;
    const conducted = Math.abs(rate - 1) > 0.02;
    this.tempoLine.classList.toggle("is-conducted", conducted);
    setText(
      this.tempoLine,
      conducted
        ? `${Math.round(local)} → ${Math.round(local * rate)} BPM`
        : `${Math.round(local)} BPM`,
    );

    if (this.mode === "conduct") {
      setText(this.conductMultiplier, `${rate.toFixed(2)}×`);
      setText(
        this.conductTempo,
        `${Math.round(local)} BPM here, played at ${Math.round(local * rate)}`,
      );
    }
    this.refreshPlayButton();
  }

  // --- panel --------------------------------------------------------------

  private buildPanel(): void {
    const settings: Setting[] = [
      {
        id: "tempo",
        label: "Tempo multiplier",
        min: 0.4,
        max: 2,
        step: 0.01,
        value: 1,
        format: (value) => `${value.toFixed(2)}×`,
        apply: (value) => {
          this.manualRate = value;
          if (this.transport?.loaded && this.mode !== "conduct") this.transport.rate = value;
        },
      },
      {
        id: "dynamics",
        label: "Dynamics",
        min: 0.4,
        max: 1.6,
        step: 0.01,
        value: 1,
        format: (value) => `${Math.round(value * 100)}%`,
        apply: () => this.engine.setDynamic(this.conductorState.dynamic * this.dynamicsSetting),
      },
      {
        id: "transpose",
        label: "Transpose",
        min: -12,
        max: 12,
        step: 1,
        value: 0,
        format: (value) => (value === 0 ? "concert pitch" : `${value > 0 ? "+" : ""}${value} st`),
        apply: (value) => this.engine.setTranspose(value),
      },
      {
        id: "tuning",
        label: "Fine tuning",
        min: -100,
        max: 100,
        step: 1,
        value: 0,
        format: (value) => (value === 0 ? "A=440" : `${value > 0 ? "+" : ""}${value} cents`),
        apply: (value) => this.engine.setFineTune(value),
      },
      {
        id: "reverb",
        label: "Hall",
        min: 0,
        max: 2,
        step: 0.05,
        value: 1,
        format: (value) => (value === 0 ? "dry" : `${Math.round(value * 100)}%`),
        apply: (value) => this.engine.setReverb(value),
      },
      {
        id: "volume",
        label: "Volume",
        min: 0,
        max: 1,
        step: 0.01,
        value: 0.85,
        format: (value) => `${Math.round(value * 100)}%`,
        apply: (value) => this.engine.setVolume(value),
      },
    ];

    this.panel = new Panel(need<HTMLElement>("panel-grid"), settings);
    // Push the defaults through once: otherwise the panel claims a value the
    // engine has never been told, and the first drag of a slider jumps.
    this.panel.applyAll();
    need<HTMLButtonElement>("panel-reset").addEventListener("click", () => {
      this.panel.resetAll();
      this.resetConductor();
    });
  }

  // --- odds and ends ------------------------------------------------------

  private bindDragAndDrop(): void {
    let depth = 0;
    const show = (visible: boolean) => this.dropHint.toggleAttribute("hidden", !visible);

    window.addEventListener("dragenter", (event) => {
      event.preventDefault();
      depth++;
      show(true);
    });
    window.addEventListener("dragover", (event) => event.preventDefault());
    window.addEventListener("dragleave", (event) => {
      event.preventDefault();
      if (--depth <= 0) {
        depth = 0;
        show(false);
      }
    });
    window.addEventListener("drop", (event) => {
      event.preventDefault();
      depth = 0;
      show(false);
      const file = event.dataTransfer?.files?.[0];
      if (file) void this.loadFile(file);
    });
  }

  private bindResize(): void {
    const observer = new ResizeObserver(() => this.waterfall.resize());
    observer.observe(this.canvas);
    window.addEventListener("orientationchange", () => this.waterfall.resize());
  }

  /** Says its piece, then gets out of the way — this is a stage, not a log. */
  private setStatus(message: string, warning = false): void {
    if (message === this.lastStatus) return;
    this.lastStatus = message;
    this.statusLine.textContent = message;
    this.statusLine.classList.toggle("is-warning", warning);
    this.statusLine.classList.remove("is-stale");
    window.clearTimeout(this.statusTimer);
    if (message && !warning)
      this.statusTimer = window.setTimeout(
        () => this.statusLine.classList.add("is-stale"),
        6000,
      );
  }
}
