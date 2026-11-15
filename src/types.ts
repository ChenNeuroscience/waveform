export type Header = Record<string, string>;
export interface CutFile {
  id: string;
  file: File;
  name: string;
  local?: boolean;
  revision?: number;
}
export interface Tetrode {
  id: string;
  number: number;
  file?: File;
  cuts: CutFile[];
}
/** A continuous-signal file: `.egf` is number 1, `.egf2` number 2, and so on. */
export interface EgfFile {
  number: number;
  file: File;
}
/** At most this many `.egf` files per trial are used (the lowest numbered). */
export const MAX_EGFS = 5;
/** `~.egf`, `~.egf2`...: an `.egf` file's name in a trial. */
export const egfName = (n: number) => `~.egf${n === 1 ? "" : n}`;
export interface Trial {
  id: string;
  name: string;
  folder: string;
  set?: File;
  pos?: File;
  tetrodes: Tetrode[];
  /** Ascending by number, at most MAX_EGFS. */
  egfs?: EgfFile[];
  /** `.egf` files beyond MAX_EGFS, by name, which aren't used. */
  ignoredEgfs?: string[];
  otherFiles?: string[];
}
export const RENDERING_MODES = ["fixed", "density", "drift"] as const;
export type RenderingMode = (typeof RENDERING_MODES)[number];
export interface Settings {
  pcaSamples: number;
  renderMode: RenderingMode;
  binCm: number;
  smooth: number;
  maxRate: number;
  rateMapSteps: number;
  acWindow: number;
  acBinMs: number;
  scMinOverlap: number;
  leds: number;
  maxSpeed: number;
  posSmooth: number;
  dirBin: number;
  dirSmooth: number;
  speedBin: number;
  speedMax: number;
  /** The LFP band-pass edges (Hz) and the frequency distribution's bin width (Hz). */
  lfpLow: number;
  lfpHigh: number;
  lfpFreqBin: number;
  /** The spike phase histogram's bin width (degrees). */
  lfpPhaseBin: number;
}
export const defaultSettings: Settings = {
  pcaSamples: 5000,
  renderMode: "density",
  binCm: 3,
  smooth: 1,
  maxRate: 0,
  rateMapSteps: 5,
  acWindow: 1000,
  acBinMs: 5,
  scMinOverlap: 20,
  leds: 2,
  maxSpeed: 4,
  posSmooth: 0.3,
  dirBin: 6,
  dirSmooth: 1,
  speedBin: 4,
  speedMax: 45,
  lfpLow: 6,
  lfpHigh: 12,
  lfpFreqBin: 0.25,
  lfpPhaseBin: 15,
};
export type PlotMode = "waveforms" | "spatial" | "direction" | "speed" | "ac" | "sc" | "phase";
export type FeatureMode = "amplitudes" | "pca";
/** Four coordinates per spike. Amplitudes are bytes; PCA is normalised float32. */
export interface FeatureCoordinates {
  key: string;
  mode: FeatureMode;
  values: Uint8Array | Float32Array;
}
/** Orthographic camera: three affine rows mapping the chosen feature axes to
 * normalised viewport x/y and depth. Shared by rendering, picking and cuts. */
export interface FeatureProjection {
  matrix: number[];
  axes: number[];
  width: number;
  height: number;
}
export interface PcaFeatures {
  asset: string;
  key: string;
  samples: number;
  values: Float32Array;
}
export interface HistoryEntry {
  id: string;
  description: string;
  changed: number;
}
export interface SplitPoint {
  source: number;
  channel: number;
  sample: number;
  threshold: number;
}
export interface SwapState {
  source: number;
}
export interface TileFeedback {
  id: string;
  session: string;
  revision: number;
  cells: number[];
}
export interface ViewData {
  revision: number;
  localCut?: { id: string; name: string };
  key: string;
  session: string;
  name: string;
  n: number;
  duration: number;
  timebase: number;
  counts: Uint32Array;
  /** Every spike: four peak-to-peak amplitudes, raw acquisition-tick time, label. */
  features: Uint8Array;
  times: Uint32Array;
  labels: Uint16Array;
  /** Resident (GPU) waveform records: all spikes up to 1M, else evenly sampled. */
  waveSlots: number;
  /** Resident slots grouped by cell; cell c occupies waveStarts[c]..waveStarts[c+1]. */
  waveOrder: Uint32Array;
  waveStarts: Uint32Array;
  /** Two u32 halves per cell of a hash of its resident slot set. */
  waveHashes: Uint32Array;
  /** Two u32 halves per cell of a hash of its full spike set (part of analysis keys). */
  cellHashes: Uint32Array;
  headers: Record<string, Header>;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  dirty: boolean;
  cached: boolean;
  residentBytes: number;
  loadMs: number;
}
/** A worker view: features/times are sent only when the recording changes. */
export type ViewMessage = Omit<ViewData, "features" | "times"> &
  Partial<Pick<ViewData, "features" | "times">>;
/** The animal's path, shared by every cell; sent once per position settings. */
export interface Trajectory {
  /** Its key in the worker's compute graph: equal keys mean an identical path. */
  key: string;
  /** The calibration used, and whether it's only a guess because no file or edit gave one. */
  ppm: number;
  ppmEstimated: boolean;
  path: Float32Array;
  arenaWidth: number;
  arenaHeight: number;
}
/** A cell's spike set: count plus a 64-bit membership hash. */
export const membershipKey = (data: ViewData, cell: number) =>
  `${data.counts[cell]}:${data.cellHashes[cell * 2]}:${data.cellHashes[cell * 2 + 1]}`;
/** The parts of a cell's analysis, each from its own handler in the worker's compute graph
 * (core/src/compute_handlers.rs), and asked for only where they're shown. */
export const ANALYSIS_PARTS = [
  "stats",
  "spatial",
  "sc",
  "direction",
  "speed",
  "speedDwell",
  "ac",
  "spikes",
  "spatialDrift",
  "spikeDrift",
  "phase",
] as const;
export type AnalysisPart = (typeof ANALYSIS_PARTS)[number];
/** A cell's analysis. Parts that weren't asked for are empty, with no key. */
export interface AnalysisData {
  /** The membership key the worker analysed (see membershipKey). */
  membership?: string;
  /** Each part's key in the compute graph: an equal key means identical values. */
  keys: Partial<Record<AnalysisPart, string>>;
  cell: number;
  arenaWidth: number;
  arenaHeight: number;
  /** stats */
  count: number;
  refractory: number;
  rate: number;
  /** spatial */
  spatial: Float32Array;
  width: number;
  height: number;
  peak: number;
  /** Full linear spatial autocorrelation, (2*width-1) by (2*height-1), if asked for. Either
   * part gives the rate map's width and height. */
  spatialAc?: Float32Array;
  direction: Float32Array;
  speed: Float32Array;
  speedDwell: Float32Array;
  ac: Float32Array;
  /** Normalised (x, y) of each spike on the path. */
  spikes: Float32Array;
  /** For drift colouring: each rate-map bin's mean spike time, and each path spike's time,
   * from 0 (the recording's start) to 1 (its last spike); NaN where a bin has no spikes. */
  spatialDrift?: Float32Array;
  spikeDrift?: Float32Array;
  /** phase: spikes in each bin of the selected `.egf` signal's band phase, across a cycle
   * from its peaks; and their circular mean (radians, 0 to 2π). Empty without an `.egf` file. */
  phase?: Float32Array;
  phaseMean?: number;
}
/** The fields each part fills. */
const PART_FIELDS: Record<AnalysisPart, (keyof AnalysisData)[]> = {
  stats: ["count", "refractory", "rate"],
  spatial: ["spatial", "width", "height", "peak"],
  sc: ["spatialAc", "width", "height"],
  direction: ["direction"],
  speed: ["speed"],
  speedDwell: ["speedDwell"],
  ac: ["ac"],
  spikes: ["spikes"],
  spatialDrift: ["spatialDrift"],
  spikeDrift: ["spikeDrift"],
  phase: ["phase", "phaseMean"],
};
/**
 * `next`, keeping `held`'s values for every part whose key is unchanged, so plots of those
 * parts see the same arrays and needn't redraw. `held` itself if nothing changed.
 */
export function reuseParts(held: AnalysisData | null, next: AnalysisData): AnalysisData {
  if (!held || held.cell !== next.cell) {
    return next;
  }
  const merged: Record<string, unknown> = { ...next };
  let changed = held.membership !== next.membership;
  for (const part of ANALYSIS_PARTS) {
    const key = next.keys[part];
    if (key && key === held.keys[part]) {
      for (const field of PART_FIELDS[part]) {
        merged[field] = held[field];
      }
    } else if (key || held.keys[part]) {
      changed = true;
    }
  }
  return changed ? (merged as unknown as AnalysisData) : held;
}
export const fileId = (f: File) => `${f.webkitRelativePath || f.name}:${f.size}:${f.lastModified}`;
/** Header values changed in the browser, by `fileId`. They are never written to the files,
 * and last only as long as the browser has the files. */
export type HeaderEdits = Record<string, Header>;
/** The position header for a sync correction. Files never have it: it exists only as an
 * edit, in ms added to position times (spike times are the reference). */
export const SYNC_HEADER = "sync_offset_ms";
/** A position header's edited value as a number, if it has a valid one. Parsed with
 * `Number`, as edits are validated (see header-edits.ts). */
function editedNumber(trial: Trial | undefined, edits: HeaderEdits, key: string) {
  const text = trial?.pos ? edits[fileId(trial.pos)]?.[key] : undefined;
  const value = Number(text);
  return text !== undefined && text.trim() !== "" && Number.isFinite(value) ? value : undefined;
}
/** A trial's position, as the worker's compute graph takes it (see core/src/compute.rs). */
export const positionSource = (trial: Trial | undefined, edits: HeaderEdits) => ({
  pos: trial?.pos,
  posFile: trial?.pos ? `${trial.id}|${fileId(trial.pos)}` : undefined,
  ppm: editedNumber(trial, edits, "pixels_per_metre"),
  sync: editedNumber(trial, edits, SYNC_HEADER),
});
/** A trial's `.egf` file number `n`, as the worker's compute graph takes it. */
export const egfSource = (trial: Trial | undefined, n: number) => {
  const egf = trial?.egfs?.find((e) => e.number === n)?.file;
  return { egf, egfFile: egf && trial ? `${trial.id}|${fileId(egf)}` : undefined };
};
/** Which of the position pane's plots are on (with the tiles' speed and phase plots). Off, a
 * plot's values aren't asked for at all. */
export interface PositionPlots {
  speed: boolean;
  lfp: boolean;
}
/** Time at each instantaneous frequency of a band-passed `.egf` signal, over the recording. */
export interface LfpDistribution {
  /** Its key in the worker's compute graph: equal keys mean identical values. */
  key: string;
  /** Seconds in each bin, the first starting at `low` Hz, each `bin` Hz wide. */
  values: Float32Array;
  low: number;
  bin: number;
  /** The mean frequency (within the band), NaN if none. */
  mean: number;
}
export { groupTextColor } from "./palette";
import { groupRgb8, groupTextColor } from "./palette";
export const cellRgb = (cell: number) => groupRgb8(cell).map((value) => value / 255);
export const color = (cell: number) => `rgb(${groupRgb8(cell).join(",")})`;
/** A cell badge: the group colour with readable text. */
export const badgeStyle = (cell: number) => ({
  background: color(cell),
  color: groupTextColor(cell),
});
