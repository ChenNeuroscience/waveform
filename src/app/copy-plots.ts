import { drawAnalysis } from "../plots/AnalysisPlot";
import type { CellStat } from "../tiles/CellStats";
import type { AnalysisData, PlotMode, Settings } from "../types";

export const TILE_PLOTS = [
  // The whole trial's; each time label's map is captured after it.
  { mode: "spatial", selector: ".tile-spatial:not(.tile-label-spatial)", name: "Spatial rate map" },
  { mode: "sc", selector: ".tile-sc", name: "Spatial autocorrelation" },
  { mode: "direction", selector: ".tile-direction", name: "Head direction" },
  { mode: "speed", selector: ".tile-speed", name: "Speed" },
  { mode: "ac", selector: ".tile-ac", name: "Autocorrelation" },
  { mode: "phase", selector: ".tile-phase", name: "LFP phase" },
] as const;
export interface PlotCapture {
  mode: PlotMode;
  name: string;
  canvas: HTMLCanvasElement;
  missing?: string;
  /** For a rate map of one time label's times, the label (marked in the stats, not here). */
  label?: number;
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
  label?: number;
}

/** The stat naming a time label's rate map peak. */
export const labelPeakStat = (label: number) => `spa max L${label}`;
/** A phase (radians) as a multiple of π, e.g. "1.25π". */
export const phaseText = (radians: number) => `${(radians / Math.PI).toFixed(2)}π`;

/** A cell's stats line: the peak of each shown map, then its spike count. */
export function cellStatEntries(
  a: AnalysisData | undefined | null,
  hasPos: boolean,
  spikes: number,
  shown: { spatial: boolean; direction: boolean; phase?: boolean },
) {
  const entries = [];
  if (a && hasPos && shown.spatial && a.peak > 0) {
    entries.push({ label: "spa max", value: `${a.peak.toFixed(1)}Hz` });
  }
  for (const map of a && hasPos && shown.spatial ? (a.labelSpatial ?? []) : []) {
    if (map.peak > 0) {
      entries.push({ label: labelPeakStat(map.label), value: `${map.peak.toFixed(1)}Hz` });
    }
  }
  const direction = a && hasPos && shown.direction ? Math.max(...a.direction) : 0;
  if (direction > 0) {
    entries.push({ label: "dir max", value: `${direction.toFixed(1)}Hz` });
  }
  if (a?.phase?.some((n) => n > 0) && shown.phase && a.phaseMean !== undefined) {
    entries.push({ label: "av. phase", value: phaseText(a.phaseMean) });
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
  return frames.map(({ mode, name, width, height, label }) => {
    const canvas = document.createElement("canvas");
    // A time label's map is that label's (other trials don't have them made).
    const map =
      label === undefined ? undefined : data?.labelSpatial?.find((m) => m.label === label);
    const missing =
      !spikes || !data
        ? unavailable
        : label !== undefined && !map
          ? "Not labelled"
          : mode === "phase"
            ? data.phase?.length
              ? undefined
              : "No LFP data"
            : mode !== "ac" && !hasPos
              ? "No position data"
              : undefined;
    if (missing) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext("2d")!;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = "#bbb";
      const radius = Math.min(5, width / 4, height / 4);
      const [cx, cy] = [width / 2, height / 2];
      ctx.beginPath();
      ctx.moveTo(cx - radius, cy - radius);
      ctx.lineTo(cx + radius, cy + radius);
      ctx.moveTo(cx + radius, cy - radius);
      ctx.lineTo(cx - radius, cy + radius);
      ctx.stroke();
    } else {
      drawAnalysis(canvas, width, height, {
        data: map ? { ...data!, ...map } : data!,
        mode,
        maxRate: mode === "spatial" ? settings.maxRate : 0,
        rateMapSteps: settings.rateMapSteps,
        drift: !map && settings.renderMode === "drift",
        compact: true,
      });
    }
    return { mode, name, canvas, missing, label };
  });
}
