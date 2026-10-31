import { useEffect, useRef } from "react";
import { fitGrid } from "./plot-geometry";
import { drawSpeedBars } from "./SpeedPlot";
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
  if (compact && (mode === "ac" || mode === "speed")) {
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
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      ctx.fillStyle = mode === "sc" ? correlationColour(v) : rateMapColour(v, scale, palette);
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
  const { data, mode, maxRate, rateMapSteps, compact, speedAlignment, positionSpeed } = props;
  useEffect(() => {
    const c = canvas.current!;
    const drawing = { data, mode, maxRate, rateMapSteps, compact, speedAlignment, positionSpeed };
    const draw = () => drawAnalysis(c, c.clientWidth, c.clientHeight, drawing);
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [data, mode, maxRate, rateMapSteps, compact, speedAlignment, positionSpeed]);
  return (
    <canvas
      ref={canvas}
      className="analysis-canvas"
      aria-label={
        mode === "ac"
          ? "Temporal autocorrelogram"
          : mode === "sc"
            ? "Spatial autocorrelogram"
            : `${mode} plot`
      }
    />
  );
}
