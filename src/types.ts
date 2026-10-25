export type Header = Record<string, string>;
export interface CutFile {
  id: string;
  file: File;
  name: string;
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
}
export interface Settings {
  pointSize: number;
  opacity: number;
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
}
export const defaultSettings: Settings = {
  pointSize: 1,
  opacity: 0.65,
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
export interface ViewData {
  revision: number;
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
  ac: Float32Array;
  refractory: number;
  rate: number;
  sampledPairs: boolean;
}
export const fileId = (f: File) =>
  `${f.webkitRelativePath || f.name}:${f.size}:${f.lastModified}`;
export const cellRgb = (cell: number) =>
  cell === 0
    ? [0.36, 0.42, 0.48]
    : [0, 0.33, 0.67].map(
        (v) => 0.5 + 0.35 * Math.cos(Math.PI * 2 * (v + cell * 0.381966)),
      );
export const color = (cell: number) =>
  `rgb(${cellRgb(cell)
    .map((v) => Math.round(v * 255))
    .join(",")})`;
