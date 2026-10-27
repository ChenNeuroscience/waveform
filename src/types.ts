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
export interface Trial {
  id: string;
  name: string;
  folder: string;
  set?: File;
  pos?: File;
  tetrodes: Tetrode[];
  otherFiles?: string[];
}
export interface Settings {
  pointSize: number;
  drift: boolean;
  density: boolean;
  binCm: number;
  smooth: number;
  maxRate: number;
  acWindow: number;
  leds: number;
  maxSpeed: number;
  posSmooth: number;
  dirBin: number;
  speedBin: number;
  speedMax: number;
}
export const defaultSettings: Settings = {
  pointSize: 1,
  drift: false,
  density: true,
  binCm: 3,
  smooth: 1,
  maxRate: 0,
  acWindow: 100,
  leds: 2,
  maxSpeed: 4,
  posSmooth: 0.3,
  dirBin: 6,
  speedBin: 4,
  speedMax: 45,
};
export type PlotMode = "waveforms" | "spatial" | "direction" | "speed" | "ac";
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
  /** Two u32 halves per cell of a hash of its full spike set (analysis cache key). */
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
  path: Float32Array;
  arenaWidth: number;
  arenaHeight: number;
}
/** Cache key for a cell's spike set: count plus a 64-bit membership hash. */
export const membershipKey = (data: ViewData, cell: number) =>
  `${data.counts[cell]}:${data.cellHashes[cell * 2]}:${data.cellHashes[cell * 2 + 1]}`;
export interface AnalysisData {
  /** The membership key the worker analysed (see membershipKey). */
  membership?: string;
  arenaWidth: number;
  arenaHeight: number;
  cell: number;
  spatial: Float32Array;
  width: number;
  height: number;
  peak: number;
  spikes: Float32Array;
  direction: Float32Array;
  speed: Float32Array;
  speedDwell: Float32Array;
  ac: Float32Array;
  refractory: number;
  rate: number;
}
export const fileId = (f: File) =>
  `${f.webkitRelativePath || f.name}:${f.size}:${f.lastModified}`;
export { groupTextColor } from "./palette";
import { groupRgb8 } from "./palette";
export const cellRgb = (cell: number) =>
  groupRgb8(cell).map((value) => value / 255);
export const color = (cell: number) => `rgb(${groupRgb8(cell).join(",")})`;
