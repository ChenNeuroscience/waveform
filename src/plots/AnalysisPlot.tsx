import { useEffect, useRef } from "react";
import { fitGrid } from "./plot-geometry";
import { drawSpeedBars } from "./SpeedPlot";
import { PHASE_BLUE } from "./LfpPlot";
import { type AnalysisData, type PlotMode } from "../types";
import { correlationColour, rateMapColour, rateMapPalette } from "../palette";

export interface AnalysisDrawing {
  data: AnalysisData;
  mode: PlotMode;
  maxRate: number;
  rateMapSteps?: number;
  compact?: boolean;
  speedAlignment?: "left" | "right";
  positionSpeed?: boolean;
  /** Drift colouring for the rate map: opacity for rate, red (early) to green (late) for
   * each bin's mean spike time, as drift colours waveforms and features. Needs
   * `data.spatialDrift`. */
  drift?: boolean;
}
/** A drift colour: red at the recording's start to green at its end, at `alpha`. */
export function driftColour(t: number, alpha = 1) {
  const c = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v)));
  return `rgba(${c(1 - t)},${c(t)},0,${alpha})`;
}

/** Draw an analysis plot into a canvas of the given CSS size (also used off-screen). */
export function drawAnalysis(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  {
    data,
    mode,
    maxRate,
    rateMapSteps = 5,
    compact = false,
    speedAlignment = "right",
    positionSpeed = false,
    ...options
  }: AnalysisDrawing,
) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  let w = width;
  let h = height;
  ctx.fillStyle = "#ffffff";
  if (!positionSpeed) {
    ctx.fillRect(0, 0, w, h);
  }
  if (compact && (mode === "ac" || mode === "speed" || mode === "phase")) {
    const box = fitGrid(w, h, mode === "ac" ? 128 : 24, mode === "ac" ? 32 : 80);
    ctx.translate(mode === "speed" && speedAlignment === "left" ? 0 : box.x, box.y);
    ctx.scale(box.unit, box.unit);
    w = mode === "ac" ? 128 : 24;
    h = mode === "ac" ? 32 : 80;
  }
  if (mode === "spatial" || mode === "sc") {
    const values = mode === "sc" ? data.spatialAc || new Float32Array() : data.spatial;
    const columns = mode === "sc" ? data.width * 2 - 1 : data.width;
    const rows = mode === "sc" ? data.height * 2 - 1 : data.height;
    const scale = maxRate || data.peak || 1;
    const palette = rateMapPalette(rateMapSteps);
    const box = fitGrid(w, h, columns, rows);
    // Whole device-pixel boundaries keep adjacent bins from blending extra colours.
    const xs = Array.from(
      { length: columns + 1 },
      (_, x) => Math.round((box.x + x * box.unit) * dpr) / dpr,
    );
    const ys = Array.from(
      { length: rows + 1 },
      (_, y) => Math.round((box.y + y * box.unit) * dpr) / dpr,
    );
    const drift = mode === "spatial" && options.drift ? data.spatialDrift : undefined;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (drift) {
        // Over the white background: unvisited and silent bins stay white.
        if (!Number.isFinite(v) || !Number.isFinite(drift[i])) {
          continue;
        }
        ctx.fillStyle = driftColour(drift[i], Math.min(1, v / scale));
      } else {
        ctx.fillStyle = mode === "sc" ? correlationColour(v) : rateMapColour(v, scale, palette);
      }
      const x = i % columns;
      const y = Math.floor(i / columns);
      ctx.fillRect(xs[x], ys[y], xs[x + 1] - xs[x], ys[y + 1] - ys[y]);
    }
  } else if (mode === "direction") {
    const a = data.direction;
    const max = Math.max(...a, 1);
    const r = Math.min(w, h) * 0.4;
    const cx = w / 2;
    const cy = h / 2;
    ctx.strokeStyle = "#dddddd";
    for (const k of [0.5, 1]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = "#111111";
    ctx.fillStyle = "transparent";
    ctx.beginPath();
    for (let i = 0; i <= a.length; i++) {
      const j = i % a.length;
      const theta = (j / a.length) * Math.PI * 2 - Math.PI;
      const rr = (a[j] / max) * r;
      // v1's display convention: zero points left, pi/2 points up.
      const x = cx - Math.cos(theta) * rr;
      const y = cy - Math.sin(theta) * rr;
      if (!i) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (compact && mode === "phase") {
    // Like the speed tuning beside it (bars from the right, no axis), in the LFP plots' blue:
    // phase down from 0 (the band's peaks).
    drawSpeedBars(ctx, w, h, data.phase || new Float32Array(), "right", false, { bar: PHASE_BLUE });
  } else if (compact) {
    const a = mode === "ac" ? data.ac : positionSpeed ? data.speedDwell : data.speed;
    const max = Math.max(...a, 1);
    if (mode === "ac") {
      ctx.strokeStyle = "#f00000";
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      for (let i = 0; i < a.length; i++) {
        const x = (i / Math.max(1, a.length - 1)) * (w - 2) + 1;
        const y = h - 2 - (a[i] / max) * (h - 4);
        if (!i) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      if (a.length === 1) {
        ctx.lineTo(w - 1, h - 2 - (a[0] / max) * (h - 4));
      }
      ctx.stroke();
    } else {
      drawSpeedBars(ctx, w, h, a, speedAlignment, positionSpeed);
    }
  } else {
    const a = mode === "ac" ? data.ac : positionSpeed ? data.speedDwell : data.speed;
    const max = Math.max(...a, 1);
    const bw = (w - 36) / a.length;
    ctx.strokeStyle = "#888";
    ctx.beginPath();
    ctx.moveTo(28, 10);
    ctx.lineTo(28, h - 23);
    ctx.lineTo(w - 6, h - 23);
    ctx.stroke();
    ctx.fillStyle = "#0044cc";
    for (let i = 0; i < a.length; i++) {
      const v = (a[i] / max) * (h - 40);
      ctx.fillRect(29 + i * bw, h - 24 - v, Math.max(1, bw - 1), v);
    }
    ctx.fillStyle = "#555";
    ctx.font = "10px monospace";
    ctx.fillText("0", 25, h - 7);
    ctx.fillText(mode === "ac" ? "lag →" : "speed (cm/s) →", w / 2 - 25, h - 7);
  }
}

export function AnalysisPlot(props: AnalysisDrawing) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { data, mode, maxRate, rateMapSteps, compact, speedAlignment, positionSpeed, drift } =
    props;
  const driftValues = mode === "spatial" && drift ? data.spatialDrift : undefined;
  // Redrawn when this plot's own values change, not the rest of the cell's analysis: parts
  // whose cache keys are unchanged keep their arrays (see reuseParts).
  const values =
    mode === "spatial"
      ? data.spatial
      : mode === "sc"
        ? data.spatialAc
        : mode === "direction"
          ? data.direction
          : mode === "ac"
            ? data.ac
            : mode === "phase"
              ? data.phase
              : positionSpeed
                ? data.speedDwell
                : data.speed;
  useEffect(() => {
    const c = canvas.current!;
    const drawing = {
      data,
      mode,
      maxRate,
      rateMapSteps,
      compact,
      speedAlignment,
      positionSpeed,
      drift,
    };
    const draw = () => drawAnalysis(c, c.clientWidth, c.clientHeight, drawing);
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- values (with the map's shape) stand for data
  }, [
    values,
    driftValues,
    drift,
    data.width,
    data.height,
    data.peak,
    mode,
    maxRate,
    rateMapSteps,
    compact,
    speedAlignment,
    positionSpeed,
  ]);
  return (
    <canvas
      ref={canvas}
      className="analysis-canvas"
      aria-label={
        mode === "ac"
          ? "Temporal autocorrelogram"
          : mode === "sc"
            ? "Spatial autocorrelogram"
            : mode === "phase"
              ? "Spike LFP phase"
              : `${mode} plot`
      }
    />
  );
}
