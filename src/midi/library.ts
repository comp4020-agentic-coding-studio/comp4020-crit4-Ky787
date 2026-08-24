// The built-in repertoire, and how a file — built-in or dropped in by the
// player — becomes bytes.

export interface Piece {
  id: string;
  title: string;
  /** Short enough that five of them fit across a laptop. */
  short: string;
  composer: string;
  /** Filename under public/midi/, never a rooted URL: the deployed site lives
   *  under /<repo>/ on GitHub Pages and a leading slash would 404 there. */
  file: string;
  /** One line for the title attribute. */
  note: string;
}

export const REPERTOIRE: readonly Piece[] = [
  {
    id: "reinecke-3",
    title: "Piano Concerto No. 3",
    short: "Concerto 3",
    composer: "Reinecke",
    file: "reinecke-piano-concerto-3.mid",
    note: "Reinecke — Piano Concerto No. 3. Piano and orchestra.",
  },
  {
    id: "hummel-2",
    title: "Piano Concerto No. 2",
    short: "Concerto 2",
    composer: "Hummel",
    file: "hummel-piano-concerto-2.mid",
    note: "Hummel — Piano Concerto No. 2. Piano and orchestra.",
  },
  {
    id: "medtner-1",
    title: "Piano Concerto No. 1",
    short: "Concerto 1",
    composer: "Medtner",
    file: "medtner-piano-concerto-1.mid",
    note: "Medtner — Piano Concerto No. 1, Op. 33. Piano and orchestra.",
  },
];

/**
 * Resolve a bundled asset against the document, not the origin. Vite builds
 * with `base: "./"`, and GitHub Pages serves this repo from a sub-path, so an
 * absolute `/midi/...` is wrong in exactly the place it cannot be tested
 * locally. `document.baseURI` is right in both.
 */
export function assetUrl(path: string): string {
  return new URL(path, document.baseURI).href;
}

export const SOUNDFONT_PATH = "soundfont/GeneralUserGS.sf3";

export interface LoadedMIDI {
  binary: ArrayBuffer;
  fileName: string;
  title: string;
}

export async function fetchPiece(piece: Piece): Promise<LoadedMIDI> {
  const response = await fetch(assetUrl(`midi/${piece.file}`));
  if (!response.ok) throw new Error(`Could not load ${piece.title} (HTTP ${response.status})`);
  return {
    binary: await response.arrayBuffer(),
    fileName: piece.file,
    title: `${piece.composer} — ${piece.title}`,
  };
}

/** A file the player chose. It is read in the page; nothing is uploaded. */
export async function readLocalMIDI(file: File): Promise<LoadedMIDI> {
  return {
    binary: await file.arrayBuffer(),
    fileName: file.name,
    title: file.name.replace(/\.(mid|midi|rmi|kar|xmf)$/i, ""),
  };
}

export function looksLikeMIDI(file: File): boolean {
  return /\.(mid|midi|rmi|kar|xmf)$/i.test(file.name) || file.type === "audio/midi";
}
