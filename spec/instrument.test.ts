// Spec tests for Crit 4, "An Instrument".
//
// These assert the contracts a person cannot check at a glance: that the
// deployed bundle carries no rooted asset paths (which only 404 once it is on
// GitHub Pages, under /<repo>/), that the supplied performances still hold
// their tempo maps after everything we do to them, and that the conductor's
// arithmetic scales those maps rather than replacing them.
//
// What only the crit can judge — latency, feel, whether conducting is
// expressive rather than tiring — is deliberately not faked here.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BasicMIDI } from "spessasynth_core";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import {
  isBlackKey,
  keyLayout,
  KEY_COUNT,
  LOWEST_MIDI,
  HIGHEST_MIDI,
  WHITE_KEY_COUNT,
} from "../src/piano/geometry.ts";
import { KEY_BINDINGS, keymapForBase, clampBaseMidi } from "../src/piano/keymap.ts";
import { velocityFromDepth } from "../src/piano/keyboard.ts";
import {
  applyBeat,
  BatonTracker,
  clampMultiplier,
  dynamicFromGesture,
  MAX_LIFT,
  initialConductorState,
  ICTUS_LINE,
  NEUTRAL_LIFT,
  MAX_MULTIPLIER,
  MIN_MULTIPLIER,
  multiplierFor,
  relax,
} from "../src/conductor.ts";
import {
  extractNotes,
  familyForProgram,
  referenceTempo,
  REFERENCE_WINDOW_SECONDS,
} from "../src/midi/analysis.ts";
import { notePosition } from "../src/visualizer.ts";
import { buildRecordingMIDI, type Recording } from "../src/recorder.ts";
import { REPERTOIRE } from "../src/midi/library.ts";

const DIST = resolve("dist");

function readDist(path: string): Buffer {
  return readFileSync(resolve(DIST, path));
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}

// --- the page invites the first sound -------------------------------------

describe("the page a stranger lands on", () => {
  const doc = new JSDOM(readDist("index.html").toString("utf8")).window.document;

  it("puts a piano on the page before any interaction", () => {
    expect(doc.getElementById("piano")).toBeTruthy();
  });

  it("says how to make the first sound without being asked", () => {
    const invite = doc.getElementById("invite")?.textContent ?? "";
    expect(invite.toLowerCase()).toContain("play");
    // The three inputs the brief asks for are all named on the opening screen.
    expect(invite.toLowerCase()).toMatch(/click|tap/);
    expect(invite.toLowerCase()).toContain("type");
    // The pedal is on shift, not space: space is the page's transport key, and
    // Enter still activates a focused control.
    expect(invite.toLowerCase()).toContain("shift");
  });

  it("keeps the settings panel out of the way until it is asked for", () => {
    expect(doc.getElementById("panel")?.hasAttribute("hidden")).toBe(true);
  });

  it("gives the piano an accessible name and keyboard focus", () => {
    const piano = doc.getElementById("piano");
    expect(piano?.getAttribute("aria-label")).toBeTruthy();
    expect(piano?.getAttribute("tabindex")).toBe("0");
  });

  it("labels every control a keyboard user can reach", () => {
    for (const button of doc.querySelectorAll("button")) {
      const name = (button.textContent ?? "").trim() || button.getAttribute("aria-label");
      expect(name, `<button id="${button.id}"> has no accessible name`).toBeTruthy();
    }
    for (const input of doc.querySelectorAll<HTMLInputElement>("input:not([hidden])")) {
      const labelled =
        input.getAttribute("aria-label") ??
        doc.querySelector(`label[for="${input.id}"]`)?.textContent;
      expect(labelled, `<input id="${input.id}"> has no label`).toBeTruthy();
    }
  });
});

// --- nothing may assume it is deployed at the domain root ------------------

describe("GitHub Pages base path", () => {
  const html = readDist("index.html").toString("utf8");

  it("has no rooted asset paths in the built page", () => {
    const rooted = [...html.matchAll(/(?:src|href)="(\/[^/][^"]*)"/g)].map((m) => m[1]);
    expect(rooted, "a rooted path 404s under /<repo>/ on Pages").toEqual([]);
  });

  it("resolves runtime assets against the document, not the origin", () => {
    // library.ts builds every asset URL with `new URL(path, document.baseURI)`;
    // this catches a later edit that reintroduces a leading slash.
    const bundle = readDist(
      html.match(/src="\.\/(assets\/index-[^"]+\.js)"/)?.[1] ?? "assets/missing.js",
    ).toString("utf8");
    expect(bundle).toContain("document.baseURI");
    expect(bundle).not.toMatch(/fetch\(`\/(midi|soundfont)\//);
  });

  it("ships the sound bank and every built-in piece", () => {
    const bank = readDist("soundfont/GeneralUserGS.sf3");
    expect(bank.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bank.subarray(8, 12).toString("ascii")).toBe("sfbk");
    // The licence travels with the file it licenses.
    expect(readDist("soundfont/LICENSE-GeneralUser-GS.txt").length).toBeGreaterThan(500);
    for (const piece of REPERTOIRE) {
      expect(readDist(`midi/${piece.file}`).subarray(0, 4).toString("ascii")).toBe("MThd");
    }
  });

  it("keeps the sound bank small enough to be worth downloading", () => {
    expect(readDist("soundfont/GeneralUserGS.sf3").length).toBeLessThan(12 * 1024 * 1024);
  });
});

// --- the keyboard ----------------------------------------------------------

describe("the piano keyboard", () => {
  const layout = keyLayout();

  it("is 88 keys, A0 to C8", () => {
    expect(KEY_COUNT).toBe(88);
    expect(layout).toHaveLength(88);
    expect(layout[0].midi).toBe(LOWEST_MIDI);
    expect(layout.at(-1)?.midi).toBe(HIGHEST_MIDI);
  });

  it("has the 52 white and 36 black keys of a real piano", () => {
    expect(layout.filter((key) => !key.black)).toHaveLength(WHITE_KEY_COUNT);
    expect(layout.filter((key) => key.black)).toHaveLength(88 - WHITE_KEY_COUNT);
    expect(isBlackKey(21)).toBe(false); // A0
    expect(isBlackKey(22)).toBe(true); // A#0
    expect(isBlackKey(108)).toBe(false); // C8
  });

  it("tiles the white keys edge to edge across the full width", () => {
    const whites = layout.filter((key) => !key.black);
    expect(whites[0].x).toBeCloseTo(0, 10);
    expect(whites.at(-1)!.x + whites.at(-1)!.width).toBeCloseTo(1, 10);
    for (let i = 1; i < whites.length; i++)
      expect(whites[i].x).toBeCloseTo(whites[i - 1].x + whites[i - 1].width, 10);
  });

  it("centres each black key on the seam between its neighbours", () => {
    for (const black of layout.filter((key) => key.black)) {
      const left = layout.find((key) => !key.black && key.midi === black.midi - 1);
      expect(left).toBeTruthy();
      expect(black.centre).toBeCloseTo(left!.x + left!.width, 10);
      expect(black.width).toBeLessThan(left!.width);
    }
  });

  it("maps the typing keys to a chromatic run with no gaps or clashes", () => {
    const map = keymapForBase(48);
    expect(map.get("KeyZ")).toBe(48); // C3
    expect(map.get("KeyQ")).toBe(60); // middle C on the upper manual
    expect(map.get("KeyM")).toBe(59); // B3
    const notes = [...new Set(map.values())].sort((a, b) => a - b);
    expect(notes[0]).toBe(48);
    for (let i = 1; i < notes.length; i++) expect(notes[i]).toBe(notes[i - 1] + 1);
  });

  it("binds each physical key once", () => {
    expect(new Set(KEY_BINDINGS.map((b) => b.code)).size).toBe(KEY_BINDINGS.length);
  });

  it("keeps every octave shift on the keyboard", () => {
    for (const base of [-100, 0, 48, 60, 200]) {
      const shifted = clampBaseMidi(base);
      const notes = [...keymapForBase(shifted).values()];
      expect(Math.min(...notes)).toBeGreaterThanOrEqual(LOWEST_MIDI);
      expect(Math.max(...notes)).toBeLessThanOrEqual(HIGHEST_MIDI);
    }
  });

  it("derives velocity from how deep the key was struck", () => {
    expect(velocityFromDepth(0)).toBeLessThan(velocityFromDepth(1));
    for (const depth of [-1, 0, 0.5, 1, 2]) {
      const velocity = velocityFromDepth(depth);
      expect(velocity).toBeGreaterThanOrEqual(1);
      expect(velocity).toBeLessThanOrEqual(127);
    }
  });
});

// --- the supplied performances keep their tempo maps -----------------------

describe("the built-in repertoire", () => {
  const scores = REPERTOIRE.map((piece) => ({
    piece,
    midi: BasicMIDI.fromArrayBuffer(toArrayBuffer(readDist(`midi/${piece.file}`)), piece.file),
  }));

  for (const { piece, midi } of scores) {
    describe(piece.title, () => {
      it("is not flattened to a single tempo", () => {
        const distinct = new Set(midi.tempoChanges.map((change) => Math.round(change.tempo)));
        expect(
          distinct.size,
          "these files carry performance tempo maps; one tempo means we destroyed one",
        ).toBeGreaterThan(50);
      });

      it("is not the 120 BPM default", () => {
        const flat = midi.tempoChanges.every((change) => Math.abs(change.tempo - 120) < 0.01);
        expect(flat).toBe(false);
      });

      it("yields notes with real velocities and durations", () => {
        const notes = extractNotes(midi);
        expect(notes.length).toBeGreaterThan(1000);
        expect(new Set(notes.map((note) => note.velocity)).size).toBeGreaterThan(8);
        expect(notes.every((note) => note.end > note.start)).toBe(true);
        // sorted, because the waterfall binary-searches this array
        for (let i = 1; i < notes.length; i++)
          expect(notes[i].start).toBeGreaterThanOrEqual(notes[i - 1].start);
      });

      it("reads a local tempo that tracks the score rather than sitting still", () => {
        const samples = [0.15, 0.35, 0.55, 0.75].map((fraction) =>
          referenceTempo(midi, midi.duration * fraction),
        );
        expect(new Set(samples.map((bpm) => Math.round(bpm))).size).toBeGreaterThan(1);
        for (const bpm of samples) {
          expect(bpm).toBeGreaterThan(20);
          expect(bpm).toBeLessThan(320);
        }
      });
    });
  }

  it("gives the orchestral pieces more than one instrument family", () => {
    const orchestral = scores.find(({ piece }) => piece.id === "reinecke-3")!;
    const families = new Set(extractNotes(orchestral.midi).map((note) => note.family));
    expect(families.size).toBeGreaterThan(2);
    expect(families).toContain("piano");
    expect(families).toContain("strings");
  });

  it("maps General MIDI programs onto the families an audience would name", () => {
    expect(familyForProgram(0, 0)).toBe("piano"); // grand piano
    expect(familyForProgram(40, 0)).toBe("strings"); // violin
    expect(familyForProgram(48, 0)).toBe("strings"); // string ensemble
    expect(familyForProgram(56, 0)).toBe("brass"); // trumpet
    expect(familyForProgram(60, 0)).toBe("brass"); // french horn
    expect(familyForProgram(68, 0)).toBe("woodwind"); // oboe
    expect(familyForProgram(73, 0)).toBe("woodwind"); // flute
    expect(familyForProgram(47, 0)).toBe("percussion"); // timpani
    expect(familyForProgram(46, 0)).toBe("plucked"); // harp
    expect(familyForProgram(0, 9)).toBe("percussion"); // the drum channel wins
  });

  it("averages the local tempo over a window rather than reading a spike", () => {
    const { midi } = scores.find(({ piece }) => piece.id === "reinecke-3")!;
    const at = midi.duration / 2;
    const instantaneous = midi.tempoChanges
      .filter((change) => Math.abs(midi.midiTicksToSeconds(change.ticks) - at) < 1)
      .map((change) => change.tempo);
    const windowed = referenceTempo(midi, at, REFERENCE_WINDOW_SECONDS);
    if (instantaneous.length > 1) {
      const spread = Math.max(...instantaneous) - Math.min(...instantaneous);
      expect(
        spread,
        "if the raw map were smooth here the window would be pointless",
      ).toBeGreaterThan(0);
      expect(windowed).toBeGreaterThanOrEqual(Math.min(...instantaneous) - 1);
    }
    expect(windowed).toBeGreaterThan(20);
  });
});

// --- the conductor scales the tempo map, it does not replace it ------------

describe("conductor arithmetic", () => {
  it("scales the score's own tempo instead of setting an absolute BPM", () => {
    // The brief's worked example: a local 110 -> 105 -> 98 -> 92 conducted 20%
    // faster must still read 132 -> 126 -> 118 -> 110.
    const local = [110, 105, 98, 92];
    const multiplier = 1.2;
    expect(local.map((bpm) => Math.round(bpm * multiplier))).toEqual([132, 126, 118, 110]);
    // and the rubato — the shape of the changes — is untouched
    const shape = (values: number[]) => values.slice(1).map((v, i) => v / values[i]);
    const conducted = shape(local.map((bpm) => bpm * multiplier));
    shape(local).forEach((ratio, i) => expect(conducted[i]).toBeCloseTo(ratio, 12));
  });

  it("clamps to a musically useful range", () => {
    expect(clampMultiplier(0.01)).toBe(MIN_MULTIPLIER);
    expect(clampMultiplier(99)).toBe(MAX_MULTIPLIER);
    expect(multiplierFor(240, 60)).toBe(MAX_MULTIPLIER);
    expect(multiplierFor(10, 120)).toBe(MIN_MULTIPLIER);
  });

  it("reads a steady beat as the tempo the player means", () => {
    expect(multiplierFor(120, 120)).toBeCloseTo(1, 6);
    expect(multiplierFor(144, 120)).toBeCloseTo(1.2, 6);
    expect(multiplierFor(96, 120)).toBeCloseTo(0.8, 6);
  });

  it("is monotone: beating faster always plays faster", () => {
    // An earlier version snapped the beat onto the nearest power-of-two
    // subdivision, so at 1.4x the score's tempo the music went to 0.7x. Nothing
    // a hand does inside the clamp may reverse direction like that.
    let previous = 0;
    for (let factor = 0.3; factor <= 3; factor += 0.01) {
      const multiplier = multiplierFor(120 * factor, 120);
      expect(multiplier, `beating ${factor.toFixed(2)}x reversed direction`).toBeGreaterThanOrEqual(
        previous,
      );
      previous = multiplier;
    }
    expect(previous).toBe(MAX_MULTIPLIER);
  });

  it("converges on a steady beat instead of chasing every one", () => {
    let state = initialConductorState();
    state = applyBeat(state, { lift: 0.3, speed: 2 }, 100, 0);
    const seen: number[] = [];
    for (let beat = 1; beat <= 10; beat++) {
      // 0.5s apart against a 100 BPM score: the player wants 120, i.e. 1.2x
      state = applyBeat(state, { interval: 0.5, lift: 0.3, speed: 2 }, 100, beat * 0.5);
      seen.push(state.multiplier);
    }
    expect(seen.at(-1)).toBeCloseTo(1.2, 2);
    // monotone, so it never overshoots and swings back
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it("ignores a stumble or a long pause rather than lurching", () => {
    let state = initialConductorState();
    state = applyBeat(state, { lift: 0.3, speed: 2 }, 120, 0);
    state = applyBeat(state, { interval: 0.5, lift: 0.3, speed: 2 }, 120, 0.5);
    const settled = state.multiplier;
    state = applyBeat(state, { interval: 0.02, lift: 0.3, speed: 2 }, 120, 0.52);
    expect(state.multiplier).toBe(settled);
    state = applyBeat(state, { interval: 12, lift: 0.3, speed: 2 }, 120, 12.5);
    expect(state.multiplier).toBe(settled);
  });

  it("returns to the score's own tempo when the player stops", () => {
    let state = initialConductorState();
    state = applyBeat(state, { lift: 0.3, speed: 2 }, 120, 0);
    state = applyBeat(state, { interval: 0.35, lift: 0.5, speed: 6 }, 120, 0.35);
    expect(state.multiplier).toBeGreaterThan(1.2);
    for (let step = 0; step < 400; step++) state = relax(state, 0.35 + step * 0.05, 0.05);
    expect(state.multiplier).toBeCloseTo(1, 2);
    expect(state.dynamic).toBeCloseTo(1, 2);
    expect(state.accent).toBeCloseTo(0, 3);
  });

  it("plays louder for a bigger swing above the plane", () => {
    const small = applyBeat(
      initialConductorState(),
      { interval: 0.5, lift: 0.05, speed: 1 },
      120,
      1,
    );
    const large = applyBeat(
      initialConductorState(),
      { interval: 0.5, lift: 0.45, speed: 1 },
      120,
      1,
    );
    expect(large.dynamic).toBeGreaterThan(small.dynamic);
  });

  it("spans enough of a dynamic range to hear under an orchestra", () => {
    // The first version spanned 0.55x-1.35x of gain, which is only 8 dB and was
    // reported as barely audible while conducting. Loudness is logarithmic, so
    // the test is in dB, not in gain.
    const dB = (gain: number) => 20 * Math.log10(gain);
    const quietest = dynamicFromGesture(0);
    const loudest = dynamicFromGesture(ICTUS_LINE);
    expect(dB(loudest) - dB(quietest)).toBeGreaterThanOrEqual(18);
    // Headroom is asymmetric on purpose: there is always room to take sound
    // away, and very little to add before the mix runs out.
    expect(dB(loudest)).toBeLessThanOrEqual(6);
    expect(dB(quietest)).toBeLessThanOrEqual(-14);
  });

  it("leaves a normal swing at the volume the score asked for", () => {
    expect(dynamicFromGesture(NEUTRAL_LIFT)).toBeCloseTo(1, 6);
  });

  it("keeps the whole dynamic range reachable in the space above the plane", () => {
    // The swing is measured above the ictus, so the loudest gesture has to fit
    // between the top of the surface and the line — otherwise the top of the
    // range is off-screen and unreachable with a mouse.
    expect(MAX_LIFT).toBeLessThan(ICTUS_LINE);
    expect(dynamicFromGesture(ICTUS_LINE)).toBe(dynamicFromGesture(MAX_LIFT));
  });

  it("is monotone in gesture size, and clamps outside the usable travel", () => {
    let previous = 0;
    for (let travel = 0; travel <= 1.2; travel += 0.01) {
      const gain = dynamicFromGesture(travel);
      expect(gain).toBeGreaterThanOrEqual(previous);
      expect(Number.isFinite(gain)).toBe(true);
      previous = gain;
    }
    expect(dynamicFromGesture(-5)).toBe(dynamicFromGesture(0));
    expect(dynamicFromGesture(99)).toBe(dynamicFromGesture(MAX_LIFT));
  });

  it("reads a beat only on the downward arrival at the ictus plane", () => {
    const baton = new BatonTracker(0.7);
    expect(baton.push({ x: 0.5, y: 0.3, t: 0 })).toBeUndefined();
    expect(baton.push({ x: 0.5, y: 0.5, t: 0.1 })).toBeUndefined();
    const first = baton.push({ x: 0.5, y: 0.72, t: 0.2 });
    expect(first).toBeDefined();
    expect(first?.interval).toBeUndefined(); // nothing to compare the first to
    // The rebound is free: going back up is never a beat, whatever shape it is.
    expect(baton.push({ x: 0.4, y: 0.5, t: 0.3 })).toBeUndefined();
    expect(baton.push({ x: 0.3, y: 0.35, t: 0.4 })).toBeUndefined();
    expect(baton.push({ x: 0.45, y: 0.55, t: 0.6 })).toBeUndefined();
    const second = baton.push({ x: 0.5, y: 0.75, t: 0.7 });
    expect(second?.interval).toBeCloseTo(0.5, 6);
  });

  it("measures the swing above the plane, not the follow-through below it", () => {
    // Two beats at the same tempo: one prepared from high up, one jabbed at the
    // line but driven deep past it. The high preparation must be the loud one.
    const swing = (apex: number, depth: number) => {
      const baton = new BatonTracker(0.7);
      baton.push({ x: 0.5, y: 0.69, t: 0 });
      baton.push({ x: 0.5, y: 0.71, t: 0.05 }); // first arrival, starts the clock
      baton.push({ x: 0.5, y: apex, t: 0.3 }); // rebound and preparation
      return baton.push({ x: 0.5, y: 0.7 + depth, t: 0.55 })?.lift ?? 0;
    };
    const prepared = swing(0.25, 0.02); // high rebound, lands lightly
    const jabbed = swing(0.66, 0.29); // barely lifts, drives well below
    expect(prepared).toBeCloseTo(0.45, 6);
    expect(jabbed).toBeCloseTo(0.04, 6);
    expect(dynamicFromGesture(prepared)).toBeGreaterThan(dynamicFromGesture(jabbed));
  });

  it("starts each swing's measurement at the beat it follows", () => {
    const baton = new BatonTracker(0.7);
    baton.push({ x: 0.5, y: 0.2, t: 0 }); // a big lift before the very first beat
    baton.push({ x: 0.5, y: 0.75, t: 0.3 });
    // A small rebound after it must read small, not inherit the earlier height.
    baton.push({ x: 0.5, y: 0.62, t: 0.6 });
    const beat = baton.push({ x: 0.5, y: 0.72, t: 0.8 });
    expect(beat?.lift).toBeCloseTo(0.08, 6);
  });

  it("reports the swing in progress so the surface can show it", () => {
    const baton = new BatonTracker(0.7);
    expect(baton.lift).toBe(0);
    baton.push({ x: 0.5, y: 0.71, t: 0 });
    baton.push({ x: 0.5, y: 0.45, t: 0.2 });
    expect(baton.lift).toBeCloseTo(0.25, 6);
    baton.push({ x: 0.5, y: 0.55, t: 0.3 }); // coming back down holds the apex
    expect(baton.lift).toBeCloseTo(0.25, 6);
    baton.reset();
    expect(baton.lift).toBe(0);
  });
});

// --- the falling notes line up with the sound, and with the lead-in --------

describe("the waterfall's synchronisation contract", () => {
  const H = 600;
  const LOOKAHEAD = 3.6;

  it("lands a note on the keybed exactly at its start time", () => {
    const { bottom } = notePosition(12, 13, 12, H, LOOKAHEAD);
    expect(bottom).toBeCloseTo(H, 9);
  });

  it("brings a note in at the top exactly one lookahead earlier", () => {
    const { bottom } = notePosition(12, 13, 12 - LOOKAHEAD, H, LOOKAHEAD);
    expect(bottom).toBeCloseTo(0, 9);
  });

  it("draws a note's length as its height, whatever the tempo", () => {
    // The renderer is never told the playback rate: `time` is score seconds, so
    // a conducted 2x simply advances `time` twice as fast through the same map.
    for (const time of [8, 10, 11.5, 12]) {
      const { top, bottom } = notePosition(12, 14, time, H, LOOKAHEAD);
      expect(bottom - top).toBeCloseTo((2 / LOOKAHEAD) * H, 9);
    }
  });

  it("moves the picture at one screen height per lookahead", () => {
    const a = notePosition(12, 13, 5, H, LOOKAHEAD).bottom;
    const b = notePosition(12, 13, 5 + LOOKAHEAD, H, LOOKAHEAD).bottom;
    expect(b - a).toBeCloseTo(H, 9);
  });

  it("puts the first note of a piece at the very top when the lead-in starts", () => {
    // What the lead-in is for: the transport starts the clock a full lookahead
    // before the first note, so the piece arrives from the top of the stage
    // instead of appearing on the keys the instant playback begins.
    for (const firstNote of [0, 1.512, 30]) {
      const leadFrom = firstNote - LOOKAHEAD;
      expect(notePosition(firstNote, firstNote + 1, leadFrom, H, LOOKAHEAD).bottom).toBeCloseTo(
        0,
        9,
      );
      expect(notePosition(firstNote, firstNote + 1, firstNote, H, LOOKAHEAD).bottom).toBeCloseTo(
        H,
        9,
      );
    }
  });
});

// --- a recording is a real MIDI file, so everything else just works --------

describe("recording", () => {
  const recording: Recording = {
    program: 0,
    length: 2.5,
    events: [
      { kind: "sustain", time: 0.0, down: true },
      { kind: "on", time: 0.1, midi: 60, velocity: 96 },
      { kind: "on", time: 0.1, midi: 64, velocity: 72 },
      { kind: "off", time: 0.9, midi: 60 },
      { kind: "off", time: 1.2, midi: 64 },
      { kind: "on", time: 1.4, midi: 67, velocity: 118 },
      { kind: "sustain", time: 2.0, down: false },
      { kind: "off", time: 2.4, midi: 67 },
    ],
  };

  const parsed = BasicMIDI.fromArrayBuffer(buildRecordingMIDI(recording, "take"), "take.mid");

  it("writes a file the same parser reads back", () => {
    expect(parsed.tracks.length).toBeGreaterThan(0);
    expect(parsed.duration).toBeGreaterThan(2.3);
  });

  it("keeps pitch, start, length and velocity", () => {
    const notes = extractNotes(parsed).sort((a, b) => a.start - b.start || a.midi - b.midi);
    expect(notes.map((note) => note.midi)).toEqual([60, 64, 67]);
    expect(notes[0].start).toBeCloseTo(0.1, 2);
    expect(notes[0].end - notes[0].start).toBeCloseTo(0.8, 2);
    expect(notes[0].velocity).toBe(96);
    expect(notes[1].velocity).toBe(72);
    expect(notes[2].velocity).toBe(118);
    expect(notes[2].start).toBeCloseTo(1.4, 2);
  });

  it("keeps the sustain pedal", () => {
    const pedal = parsed.tracks
      .flatMap((track) => [...track.events])
      .filter((event) => (event.statusByte & 0xf0) === 0xb0 && event.data[0] === 64);
    expect(pedal.length).toBeGreaterThanOrEqual(2);
    expect(pedal.some((event) => event.data[1] >= 64)).toBe(true);
    expect(pedal.some((event) => event.data[1] < 64)).toBe(true);
  });

  it("plays back at one clean tempo, since a live take has no tempo map", () => {
    const tempos = new Set(parsed.tempoChanges.map((change) => Math.round(change.tempo)));
    expect([...tempos]).toEqual([120]);
  });
});
