import { drawAnalysis } from "../plots/AnalysisPlot";
import type { CellStat } from "../tiles/CellStats";
import type { AnalysisData, PlotMode, Settings } from "../types";

export const TILE_PLOTS = [
  { mode: "spatial", selector: ".tile-spatial", name: "Spatial rate map" },
  { mode: "direction", selector: ".tile-direction", name: "Head direction" },
  { mode: "speed", selector: ".tile-speed", name: "Speed" },
  { mode: "ac", selector: ".tile-ac", name: "Autocorrelation" },
] as const;
export interface PlotCapture {
  mode: PlotMode;
  name: string;
  canvas: HTMLCanvasElement;
  missing?: string;
}
export interface CellCapture {
  cell: number;
  spikes: number;
  stats: CellStat[];
  plots: PlotCapture[];
}
export interface AnalysisFrame {
  mode: Exclude<PlotMode, "waveforms">;
  name: string;
  width: number;
  height: number;
}

export function cellStatEntries(
  a: AnalysisData | undefined | null,
  hasPos: boolean,
  spikes: number,
) {
  const entries = [];
  if (a && hasPos && a.peak > 0) {
    entries.push({ label: "spa max", value: `${a.peak.toFixed(1)}Hz` });
  }
  const direction = a && hasPos ? Math.max(...a.direction) : 0;
  if (direction > 0) {
    entries.push({ label: "dir max", value: `${direction.toFixed(1)}Hz` });
  }
  entries.push({ label: "n spikes", value: spikes.toLocaleString() });
  return entries;
}

/** Draw secondary analyses at exactly the primary tile's plot sizes. */
export function captureAnalysisPlots(
  data: AnalysisData | undefined | null,
  spikes: number,
  hasPos: boolean,
  settings: Settings,
  frames: AnalysisFrame[],
  unavailable = "No data",
): PlotCapture[] {
  const dpr = Math.min(2, devicePixelRatio || 1);
  return frames.map(({ mode, name, width, height }) => {
    const canvas = document.createElement("canvas");
    const missing =
      !spikes || !data ? unavailable : mode !== "ac" && !hasPos ? "No position data" : undefined;
    if (missing) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext("2d")!;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = "#bbb";
      const radius = Math.min(5, width / 4, height / 4);
      ctx.beginPath();
      ctx.moveTo(width / 2 - radius, height / 2 - radius);
      ctx.lineTo(width / 2 + radius, height / 2 + radius);
      ctx.moveTo(width / 2 + radius, height / 2 - radius);
      ctx.lineTo(width / 2 - radius, height / 2 + radius);
      ctx.stroke();
    } else {
      drawAnalysis(canvas, width, height, {
        data: data!,
        mode,
        maxRate: mode === "spatial" ? settings.maxRate : 0,
        rateMapSteps: settings.rateMapSteps,
        compact: true,
      });
    }
    return { mode, name, canvas, missing };
  });
}
