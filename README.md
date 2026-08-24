# Rubato

An 88-key piano in the browser, and an orchestra you can conduct.

COMP4020 / COMP8020 Agentic Coding Studio, Crit 4 —
[*An Instrument*](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/04-instrument/).

Click a key, tap it, or type — the piano is playable the moment the page
settles, with no instructions and no wrong notes. Load one of three concertos
and you land in **Conduct**: the notes fall from the top of the screen onto the
keys they belong to, each section in its own colour, and the music follows your
hand. Switch to **Play the piano** whenever you want to play along instead.

## The idea

The conductor **multiplies the performance's own tempo map** rather than
replacing it. The supplied MIDI files carry tempo maps synchronised to real
performances — 1,387 to 2,176 tempo events each. Flattening them to a slider
would throw away the thing that makes them worth listening to. Conducting 20%
faster turns a local 110 → 105 → 98 → 92 into 132 → 126 → 118 → 110: your
reading, their rubato.

## Playing it

| | |
|---|---|
| Mouse / touch | Click or tap the keys. Strike lower on a key for a louder note; drag across for a glissando. |
| Typing | `Z` `X` `C` `V`… and `Q` `W` `E` `R`… are two octaves, blacks on `S` `D` `G` and `2` `3` `5`. |
| Pedal | Hold `shift` (either one). |
| Octave | `←` and `→`. |
| Play / pause | `space`, anywhere on the page. |
| Conduct | Load a piece, press **Conduct**, then drop onto the line, rebound, and drop again. The line is the ictus — only the downward arrival counts, so there is no pattern to get right. The higher you rebound, the louder the next beat; a sharper arrival accents it. Stop, and the tempo eases back to the score's own reading. |
| Record | **Record**, play, **Stop**, **Play my take** — a take is a real MIDI file, so you can conduct it too. |
| Your own MIDI | **Open a MIDI file**, or drop one on the page. It is read in the browser and never uploaded. |

## How it is put together

```
src/audio/engine.ts    AudioContext, SoundFont synth, master chain
src/transport.ts       one sequencer, one score, the clock everything reads
src/midi/              repertoire, note extraction, orchestral families, local tempo
src/piano/             88-key geometry, typing map, pointer/touch/keyboard input
src/visualizer.ts      canvas waterfall, painted for the visible window only
src/conductor.ts       beat maths (pure) and the baton tracker
src/recorder.ts        a live take, written out as a Standard MIDI File
src/app.ts             wiring, modes, controls
```

Two things hold the design together. Synthesis runs in an **AudioWorklet**, off
the main thread, so a 45,000-note concerto and a live keyboard share a page
without the keyboard stuttering. And the transport's clock is measured in
**score seconds**, as are the note positions the waterfall draws — so at any
conducted tempo the picture cannot drift from the audio, because there is only
one clock.

## Credits

- **[spessasynth_lib](https://github.com/spessasus/spessasynth_lib)** — SF2/SF3
  synthesis and MIDI sequencing for the Web Audio API. Apache-2.0.
- **[GeneralUser GS](https://www.schristiancollins.com/generaluser.php)** by
  S. Christian Collins — the General MIDI sound bank, shipped as the 8.4 MB
  compressed SF3 build. GeneralUser GS License v2.0, which permits
  redistribution; the licence text ships beside the file at
  `public/soundfont/LICENSE-GeneralUser-GS.txt`.
- The three concerto performances were supplied with this deliverable;
  `public/midi/PROVENANCE.txt` and `validation.json` record what was corrected
  in them and that their tempo maps survived.

## Working on it

```sh
mise install
pnpm install
pnpm dev             # local dev server
pnpm check           # typecheck, build, spec tests
pnpm check:evidence  # the process-evidence check CI runs
pnpm build           # produce dist/, which is what deploys
```

`PROCESS.md` is the reading guide to how this came together; `CLAUDE.md` carries
the rules the build had to learn, including the two that cost the most time.
`spec/` holds the invariants that ship with the course template plus
`instrument.test.ts`, this deliverable's own contracts.
