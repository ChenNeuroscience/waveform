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
  budget: number;
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
  budget: 250_000,
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
  features: Uint8Array;
  times: Float32Array;
  labels: Uint16Array;
  indices: Uint32Array;
  waves: Int8Array;
  waveLabels: Uint16Array;
  waveIndices: Uint32Array;
  headers: Record<string, Header>;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  dirty: boolean;
  cached: boolean;
  residentBytes: number;
  loadMs: number;
}
export interface AnalysisData {
  arenaWidth: number;
  arenaHeight: number;
  cell: number;
  spatial: Float32Array;
  width: number;
  height: number;
  peak: number;
  path: Float32Array;
  spikes: Float32Array;
  direction: Float32Array;
  speed: Float32Array;
  speedDwell: Float32Array;
  ac: Float32Array;
  refractory: number;
  rate: number;
  sampledPairs: boolean;
}
export const fileId = (f: File) =>
  `${f.webkitRelativePath || f.name}:${f.size}:${f.lastModified}`;
export { groupTextColor } from "./palette";
import { groupRgb8 } from "./palette";
export const cellRgb = (cell: number) =>
  groupRgb8(cell).map((value) => value / 255);
export const color = (cell: number) => `rgb(${groupRgb8(cell).join(",")})`;
