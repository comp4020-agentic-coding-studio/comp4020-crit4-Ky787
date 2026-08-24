# COMP4020/COMP8020 Crit 4 — Instrument

## Project goal

This repository implements Crit 4, “An Instrument”.

The browser must itself be an expressive musical instrument. Prioritise playability and interaction quality over feature count.

Course brief:
https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/04-instrument/

## Core experience

The project is a browser piano/MIDI instrument with:

* an on-screen piano fixed along the bottom of the main experience;
* mouse, touch and computer-keyboard piano input;
* falling-note visualization;
* live piano recording and playback;
* built-in and locally uploaded MIDI playback;
* multi-instrument General MIDI/SoundFont synthesis;
* a conductor mode that reshapes MIDI playback live.

The UI should feel like an instrument, not a DAW.

## UX rules

* The first screen must immediately invite the user to make sound.
* The piano and music visualization are visually dominant.
* Keep permanent controls minimal.
* Put secondary transforms/settings in a collapsible panel.
* Do not require instructions before the first interaction.
* There is no score, failure state or wrong way to play.
* Mouse, keyboard and touch should all be meaningful inputs.
* Avoid generic dashboard styling.

## MIDI rules

The supplied MIDI examples contain synchronised variable-tempo maps.

Never flatten them to a fixed BPM.

Preserve where supported:

* tempo events;
* time signatures;
* note velocity/duration;
* program/instrument assignments;
* sustain;
* expression and volume controllers.

Prefer `spessasynth_lib` for browser SoundFont/MIDI synthesis unless there is a documented technical reason to use something else.

Built-in MIDI and SoundFont assets must work from the deployed GitHub Pages base path.

## Conductor mode

Conductor mode should be gesture-first, not slider-first.

The main interaction is a baton-like pointer/touch gesture over the central visualization.

A downward crossing of a beat line can establish conducted beats.

Conducted tempo modifies the MIDI's existing local tempo:

`effective tempo = original local tempo × conductor multiplier`

Smooth conductor input to avoid jitter.

Gesture size may influence dynamics and gesture velocity may influence accents if this feels musical.

Transpose/tuning and similar non-conductor transformations belong in secondary controls.

## Engineering priorities

Prioritise in this order:

1. responsive live piano;
2. correct multi-instrument MIDI playback;
3. synchronised falling-note visualization;
4. recording/playback;
5. reliable conductor tempo control;
6. expressive conducting;
7. secondary transformations;
8. visual polish.

Do not sacrifice reliable core interaction to add marginal features.

Keep audio timing separate from animation timing.

For large MIDI files, render only the visible note window rather than creating DOM elements for every note.

## Project constraints

* Preserve the starter/invariant checks.
* Preserve GitHub Pages deployment.
* Run the existing checks before and after substantial changes.
* Avoid unnecessary architecture rewrites.
* Do not hardcode deployment-root asset URLs.
* Resume Web Audio only after an appropriate user gesture.
* Keep client-side MIDI uploads local to the browser.

## Process

Work incrementally and make meaningful commits at working milestones.

Keep `PROCESS.md` factual and current with:

* decisions;
* experiments;
* problems;
* corrections;
* scope changes;
* testing results.

Do not fabricate subjective reflection content in `reflections/crit-4.md`; factual implementation notes and clearly marked reflection prompts are fine.

When an external library API is uncertain, check its current documentation/examples rather than guessing.

