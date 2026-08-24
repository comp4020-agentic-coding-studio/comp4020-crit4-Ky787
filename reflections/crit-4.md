# Crit 4 — An Instrument

<!--
  The two standing prompts below are mine to answer, after playing the thing.
  What is written under "Implementation notes" is factual and can stay; the
  prompts under each heading are scaffolding — replace them with what I actually
  think, and delete this comment.
-->

## 1. What was the breakthrough that moved the work forward?

_To write after playing it._

Prompts, from what actually happened this week — pick whichever is true, not
whichever sounds best:

- The decision to look at the data before designing the feature. The tempo maps
  in the supplied files turned out to carry instantaneous values from 5 to
  482 BPM, which ruled out the obvious baseline for conductor mode before a line
  of it was written. Did that feel like a breakthrough, or just like
  bookkeeping?
- Deleting the pulse-subdivision logic rather than tuning its threshold. The
  test that replaced it sweeps the whole input range instead of checking three
  points. Was giving up the clever version the moment the mode became playable,
  or did it lose something I want back?
- Measuring the sound with an `AnalyserNode` instead of trusting the code. Did
  that change how much I believed the rest of the build?

## 2. What did this work change about who I want to be as a software developer?

_To write after playing it._

Prompts:

- The brief calls this judgement week because an agent has no ears. Where did my
  judgement actually enter this week, and where did I let a green check stand in
  for it?
- Two of the worst defects were invisible in the source and obvious in one
  screenshot. What does that suggest about where I should be spending attention?
- The strongest correction this week went into `CLAUDE.md` and a swept test
  rather than into a retry. Is that a habit I want, and what did it cost?

## Implementation notes (factual — safe to keep)

- **Engine.** `spessasynth_lib` 4.3.x, `WorkletSynthesizer` in an AudioWorklet.
  Sound bank: GeneralUser GS v2.0.x as an 8.4 MB Ogg-compressed SF3, the build
  the library's own player bundles. Licence: GeneralUser GS License v2.0
  (permissive, redistribution allowed); the text ships next to the file at
  `public/soundfont/LICENSE-GeneralUser-GS.txt`.
- **Why that library.** It plays SF2/SF3 with a real sequencer, off the main
  thread, and exposes `playbackRate` — a multiplier over the file's existing
  tempo map. That single property is what makes "conduct without flattening the
  rubato" a two-line idea instead of a rewrite of the MIDI scheduler.
- **Timing.** The transport's clock is in *score* seconds, and so are the note
  positions the waterfall draws. At a 1.5x conducted tempo the score clock simply
  runs 1.5x faster, so the picture cannot drift from the audio. There is no
  second animation clock to keep in step.
- **Conductor.** The ictus plane sits at 70% of the surface; a downward arrival
  at it is a beat, and the rebound above it is free.
  `multiplier = userTempo / localTempo`, where `localTempo` is a ±4-second
  windowed average of the score's own tempo map, then smoothed (0.3 per beat,
  0.7 on the first) and clamped to 0.4x–2.0x. The swing above the plane sets
  dynamics over a 20 dB span defined in decibels, not gain — the first version
  spanned 8 dB and was inaudible while playing. The measurement is the highest
  point reached above the plane since the last beat, so a bigger rebound plays
  louder. Pointer speed at the crossing
  adds a one-beat accent. Three seconds without a beat and it eases back to
  1.0x. The master runs through a zero-latency soft clipper so the loud end
  cannot clip.
- **Bindings.** Space plays/pauses anywhere on the page; the sustain pedal is
  either shift. Space was the pedal first, but it also re-activated whichever
  piece button had focus, restarting the piece instead of pausing it.
- **Recording** is written out as a real SMF, so a take goes through the same
  playback, visualisation and conductor path as a concerto.
- **Lead-in.** Loading a piece starts the clock one full lookahead (3.6 s of
  score time) before its first note, so the opening falls the whole height of
  the stage instead of appearing on the keys. It also covers the ~133 ms the
  main thread spends parsing the largest file and the synthesizer's voice
  preloading. The sequencer is seeked when the lead-in begins, not at the
  handover, so the cross-thread clock has settled by the time it takes over;
  measured frame by frame, the join shows no jump.
- **Verified in Chromium**, not just asserted: mouse, touch and typed input;
  chords and the sustain pedal; octave shift; MIDI load; tempo tracking the map
  rather than sitting at 120; mode switching without losing the playhead;
  conducting audibly changing the tempo and easing back; record and play back;
  a local file loading with zero network requests; twelve GM programs resolving
  to distinct named presets with measurably distinct spectra; conducted
  dynamics measured at 17-21 dB of real spread at the master bus with the tempo
  held constant; conducted tempo settling to within 2-4% wobble; no console errors;
  no horizontal scroll at 1440x900, 1280x720, 1024x640 or 820x1180.
- **Not verified, because it needs a person:** latency as *felt*, whether the
  conducting smoothing is playable, whether the ease-back is forgiving or
  ignoring, whether 3.6 s of lead-in reads as anticipation or as waiting, and
  whether the orchestra is convincing at volume.
