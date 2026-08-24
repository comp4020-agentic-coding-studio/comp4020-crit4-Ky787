// The audio engine: one AudioContext, one SoundFont synthesizer, one master
// gain. Everything that makes a sound goes through here.
//
// spessasynth_lib runs the synthesizer in an AudioWorklet — a separate thread —
// which is why a 45,000-note concerto and a live keyboard can share a page
// without the keyboard stuttering when the main thread is busy drawing.

import { WorkletSynthesizer } from "spessasynth_lib";
// Vite emits the worklet processor as a build asset and hands back a URL that
// is correct under any deploy path. Copying it by hand would drift from the
// installed version.
import processorUrl from "spessasynth_lib/dist/spessasynth_processor.min.js?url";
import { assetUrl, SOUNDFONT_PATH } from "../midi/library.ts";

/** The channel the player's own hands own. MIDI files get 0-15. */
export const LIVE_CHANNEL = 16;

export type LoadProgress = (loaded: number, total: number) => void;

async function fetchWithProgress(url: string, onProgress?: LoadProgress): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (HTTP ${response.status})`);
  const total = Number(response.headers.get("content-length") ?? 0);
  if (!response.body || !total || !onProgress) return response.arrayBuffer();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes.buffer;
}

/**
 * A soft clipper for the master bus.
 *
 * Conducting can now ask for +4 dB over unity, and a tutti already sits close
 * to full scale, so something has to catch the peaks. A DynamicsCompressorNode
 * would be the obvious choice and is the wrong one here: it can add latency to
 * a bus a live keyboard plays through, and its pumping would fight the very
 * dynamics the conductor is shaping.
 *
 * This curve is exactly linear below -3 dBFS — so everything the player is
 * actually shaping passes through untouched — and rolls off smoothly above it
 * rather than squaring off into hard clipping. No lookahead, no latency.
 */
function softClipCurve(samples = 2048): Float32Array<ArrayBuffer> {
  const KNEE = 0.7; // ≈ -3 dBFS
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    const magnitude = Math.abs(x);
    curve[i] =
      magnitude <= KNEE
        ? x
        : Math.sign(x) * (KNEE + (1 - KNEE) * Math.tanh((magnitude - KNEE) / (1 - KNEE)));
  }
  return curve;
}

export class AudioEngine {
  readonly context: AudioContext;
  readonly master: GainNode;
  private readonly limiter: WaveShaperNode;
  synth!: WorkletSynthesizer;

  private volume = 0.85;
  private dynamic = 1;
  private ready = false;

  constructor() {
    // Created suspended. Nothing sounds until resume(), which only ever runs
    // from a real gesture — the browser's autoplay rule, and also the right
    // behaviour: a page that makes noise on load is a page you close.
    this.context = new AudioContext({ latencyHint: "interactive" });
    this.master = this.context.createGain();
    this.master.gain.value = this.volume;
    this.limiter = this.context.createWaveShaper();
    this.limiter.curve = softClipCurve();
    // "none": oversampling would improve the knee and cost latency, which on a
    // bus a live keyboard plays through is the worse trade.
    this.limiter.oversample = "none";
    this.master.connect(this.limiter).connect(this.context.destination);
  }

  get isReady(): boolean {
    return this.ready;
  }

  async init(onProgress?: LoadProgress): Promise<void> {
    await this.context.audioWorklet.addModule(processorUrl);
    this.synth = new WorkletSynthesizer(this.context);
    const bank = await fetchWithProgress(assetUrl(SOUNDFONT_PATH), onProgress);
    await this.synth.soundBankManager.addSoundBank(bank, "main");
    await this.synth.isReady;
    this.synth.connect(this.master);
    // These concertos stack a full orchestra under a soloist; the stock cap
    // steals voices audibly in the tuttis.
    this.synth.setSystemParameter("voiceCap", 400);
    this.ensureLiveChannel();
    this.ready = true;
  }

  /**
   * The player's keyboard needs a channel a loaded MIDI will never touch, so
   * playing along with an orchestra does not fight the score for channel 0.
   * Song loads can reset the channel list, so this is re-run after each one.
   */
  ensureLiveChannel(): void {
    while (this.synth.channelCount <= LIVE_CHANNEL) this.synth.addNewChannel();
  }

  /** Call from a real user gesture, every time; resuming twice is harmless. */
  async resume(): Promise<void> {
    if (this.context.state !== "running") await this.context.resume();
  }

  private applyGain(): void {
    const target = this.volume * this.dynamic;
    this.master.gain.setTargetAtTime(target, this.context.currentTime, 0.02);
  }

  /** 0..1, the player's own volume control. */
  setVolume(value: number): void {
    this.volume = value;
    this.applyGain();
  }

  /** The conductor's gesture size, as a factor around 1. */
  setDynamic(value: number): void {
    this.dynamic = value;
    this.applyGain();
  }

  setTranspose(semitones: number): void {
    this.synth.setSystemParameter("keyShift", Math.round(semitones));
  }

  setFineTune(cents: number): void {
    this.synth.setSystemParameter("fineTune", cents);
  }

  setReverb(amount: number): void {
    this.synth.setSystemParameter("reverbGain", amount);
    // Otherwise a MIDI file's own reverb sysex overwrites the player's choice.
    this.synth.setSystemParameter("reverbLock", true);
  }
}
