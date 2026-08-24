# Process overview

## What I built

**Rubato** — an 88-key piano across the bottom of the browser that answers to
mouse, touch and typing, and, above it, a note waterfall you can conduct. Load
one of three supplied concerto performances (Reinecke, Hummel, Medtner) and the
page plays it with a General MIDI
SoundFont, then hands you a baton: beating downward through a line on the stage
reshapes the tempo while you listen. The point of the mode is that it
**multiplies the performance's own tempo map instead of replacing it**, so the
players' rubato survives being reinterpreted. You can also record what you play
and conduct that.

Built on `spessasynth_lib` (AudioWorklet SoundFont synthesis, off the main
thread) with GeneralUser GS v2.0.x as an 8.4 MB compressed SF3. Live piano owns
MIDI channel 16 so you can play over the orchestra without fighting the score
for a channel.

## The moments that mattered

### 1. The tempo map cannot be used the obvious way

Conductor mode needs a baseline: `multiplier = userTempo / localTempo`. The
obvious `localTempo` is `Sequencer.currentTempo`, which the library provides.
Before writing any of it I parsed all five supplied files and printed their
tempo maps. They carry **1,352 to 2,610 tempo events**, with instantaneous
values from **5 to 482 BPM** — these are maps synchronised to real performances,
so a single tick can read 13 BPM. Dividing a hand's beat rate by one of those
spikes would have swung the multiplier from 0.4x to 2.0x between one beat and
the next, and I would have spent the afternoon "tuning the smoothing".

Instead the baseline is a **windowed average**: beats elapsed across ±4 seconds
of score, divided by the window, computed from the tempo map's own tick-to-second
mapping so it is exact rather than sampled. That is `referenceTempo` in
[`d0b1023`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-Ky787/commit/d0b1023).
The check that it was right: the transport's BPM readout tracks the music
(79 → 78 → 81 → 83 → 85 → 87 over six seconds of the Reinecke) instead of
flickering, and a spec test asserts the windowed value stays inside the
instantaneous spread while the raw map around it does not.

> the prompt that started it, before any conductor code:
> "print the tempo map, note count and program assignments for every file in
> public/midi/ before we design the conductor"

### 2. Deleting the clever part of the conductor

I had the conductor snap the player's beat onto the nearest power-of-two
subdivision before dividing, reasoning that conductors beat one to the bar in an
Allegro. Writing the arithmetic as pure functions and testing it showed the
problem immediately: **beating 1.4x the score's tempo was read as half-time and
played at 0.7x** — the music slowing down because the hand sped up.

The obvious fix was a tolerance band. I tried two (2.2, then 2.6) and both just
moved the reversal to a different speed inside the range a hand can reach; the
wider one also made the half-time pulse practically unreachable, so the feature
no longer did the thing it existed for. So I deleted it. The multiplier is now
the brief's formula and nothing else.

What makes this the moment rather than a retry is where the correction landed.
The replacement is not a better threshold — it is a test that **sweeps the whole
input range asserting the output never reverses direction**, plus a rule in
`CLAUDE.md` that rules out the entire family of clever-subdivision ideas rather
than the one instance I caught
([`c08dba7...203319f`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-Ky787/compare/c08dba7...203319f)).
Driving the page afterwards, the same fast gesture that used to give 1.17x now
gives 1.98x, and the same slow one 0.89x — monotone, in the direction the hand
is asking for.

### 3. An agent has no ears, so measure the sound

The brief calls this judgement week because an agent can build a synth and not
hear it. Two required claims — "several General MIDI instruments actually sound
different" and "no console errors during normal use" — cannot be checked by
reading code, so I drove the built page in Chromium: click keys, type chords,
hold the pedal, load a concerto, conduct it, record a take, play it back.

For timbre specifically I tapped the master bus with an `AnalyserNode` and
measured twelve programs. They resolve to their correct named presets and their
spectra genuinely differ — Grand Piano's spectral centroid is 4635 Hz against
French Horns' 2881 Hz, and the clarinet shows the textbook suppressed even
harmonics (-44, **-78**, -51, **-100**, -53 dB) that a piano sample could not
fake. My first, cruder metric had reported piano and horn as identical; the
finer measurement showed that was my measurement's fault, not the synth's.

The same pass caught two defects invisible in the source: `[hidden]` was doing
nothing on anything styled with `display`, so the drag-and-drop target covered
the stage from first paint, and the bar's nowrap chips sized the grid's implicit
column past the viewport, putting the right-hand controls off-screen
([`c08dba7`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-Ky787/commit/c08dba7)).
Re-checked at 1440x900, 1280x720, 1024x640 and 820x1180: no horizontal scroll,
piano visible, every control reachable, zero console errors.

### 4. The start of a piece was the worst-feeling moment in it

Playing it, the first thing that went wrong was the beginning: pressing a piece
started the music abruptly, with its notes already touching the keys and nothing
visibly falling. Measuring the click found a second problem underneath — the
main thread blocks for **133 ms** parsing the Medtner's 45,366 notes, right at
the moment sound was supposed to start.

The fix addresses both at once rather than either separately. The transport now
runs a **lead-in** on its own clock: one full lookahead of score time before the
first note, during which the sequencer waits and the opening bars descend the
whole height of the stage. The parse hitch and the synthesizer's voice
preloading both disappear behind a stretch that is meant to be quiet anyway
([`ee78553`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-Ky787/commit/ee78553)).

The risk in handing a clock from the page to another thread is a jump at the
join, so the seek happens when the lead-in *starts*, giving the sequencer's
cross-thread `timeChange` seconds to come back. I checked it frame by frame
rather than by eye: the clock reads identically on the last lead-in frame and
the first playing frame, for a piece whose first note is at 1.512 s and one
whose first note is at 0. And the arithmetic the whole thing rests on is now a
pure function with tests — a note reaches the keybed exactly at its start time,
and enters at the top exactly one lookahead earlier.

I did not move the parse off the main thread. 133 ms once per load, now covered
by a painted loading state and followed by a deliberate pause, did not justify a
worker and the cost of shipping 45,000 note objects back across it.

### 5. Three corrections that only came from playing it

Everything above was found by measuring. These came from the instrument being
used, which is the part no check replaces.

**Conducted dynamics were inaudible.** The gesture-to-loudness mapping spanned
0.55x to 1.35x of gain, which reads as a wide range and is about 8 dB — under a
full orchestra you could not hear it. Loudness is logarithmic and the mapping
was not, so it is now defined in dB and spans 20, deliberately lopsided: 16 dB
below a neutral beat against 4 above, because there is always room to take sound
away and very little to add. Measured at the master bus while conducting, small
beats against large now differ by **21 dB** of real output. The extra headroom
needed catching, so the master runs through a soft clipper — a WaveShaper, not a
compressor, because a compressor would add latency to a bus a live keyboard
plays through and its pumping would fight the dynamics being shaped.

**Space restarted the piece instead of pausing it.** Space was the sustain pedal,
the usual virtual-piano binding. But clicking a piece leaves focus on its
button, so space activated that button and reloaded the piece from the top. The
binding and the bug were both wrong: space is now the transport key everywhere
and always prevents the default (Enter still activates a focused control), the
pedal moved to either shift, and a pointer click on a chip now returns focus to
the page. The rule is in `CLAUDE.md` so it does not drift back.

**The two solo pieces went.** The repertoire is three concertos now. The solo
works exercised nothing the concertos do not, and conductor mode is more
interesting with an orchestra under the soloist than with one instrument.

## Scope decisions

- **A recording is written out as a real Standard MIDI File**, not kept as an
  event list. It costs about forty lines and means playback, the waterfall and
  conductor mode all work on a take with no special-case code. Velocity, note
  length and the sustain pedal survive the round trip, which a spec test checks.
- **No fermata gesture.** The brief suggests a pause-the-pointer hold and says
  to drop it if it feels frustrating. Holding still is also what a hand does
  between beats, so the two are hard to tell apart reliably; instead the tempo
  eases predictably back to the score's own reading three seconds after the last
  beat. This is one of the things I most want to test by hand.
- **The waterfall is canvas, and only paints the visible window.** The Medtner
  concerto is 45,366 notes; one element each would be 45,366 elements. Notes are
  found by binary search each frame, so frame cost tracks what is on screen, not
  the length of the piece.
- **Two large commits, then small ones.** The first working instrument is one
  commit because its modules do not typecheck apart, and committing a red state
  to manufacture a nicer history seemed worse than saying so here. Everything
  after it is incremental.

## Testing

`pnpm check` is green: 75 spec tests over base-path safety, the tempo maps
surviving, keyboard geometry, conductor arithmetic, the waterfall's
synchronisation contract, and the recording round trip.
`pnpm dlx linkinator ./dist` passes. The browser scenarios that produced the
numbers quoted above are not committed — they drive a live dev server through
`puppeteer-core` and are not part of CI — but their findings are, in the tests
and in `CLAUDE.md`.

**What still needs ears and a hand**, and cannot be settled here: whether the
key action feels responsive rather than merely fast, whether the conducting
smoothing is playable or sluggish, whether the ease-back after you stop
conducting reads as forgiving or as the instrument ignoring you, and whether
the SoundFont's orchestra is convincing at concert volume. Those are notes in
`reflections/crit-4.md`.
