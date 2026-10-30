import { useEffect, useRef } from "react";
import { fitGrid } from "./plot-geometry";

/** Shared bars for compact speed tuning and position-only speed dwell plots. */
export function drawSpeedBars(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  values: Float32Array,
  alignment: "left" | "right",
  axis: boolean,
) {
  const max = Math.max(...values, 1);
  const bh = h / values.length;
  ctx.fillStyle = "#111";
  for (let i = 0; i < values.length; i++) {
    if (!(values[i] > 0)) {
      continue;
    }
    const bw = (values[i] / max) * (w - 1);
    ctx.fillRect(alignment === "left" ? 0 : w - bw, i * bh, bw, Math.max(0.5, bh - 0.4));
  }
  if (axis) {
    ctx.fillStyle = "#f00";
    ctx.fillRect(0, 0, 0.6, h);
  }
}

/** Depends only on the trial's speed dwell, so cell analysis can reload freely. */
export function SpeedDwellPlot({ values }: { values: Float32Array }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current!;
    const draw = () => {
      const w = c.clientWidth;
      const h = c.clientHeight;
      const dpr = Math.min(2, devicePixelRatio || 1);
      c.width = w * dpr;
      c.height = h * dpr;
      const ctx = c.getContext("2d")!;
      ctx.scale(dpr, dpr);
      const box = fitGrid(w, h, 24, 80);
      ctx.translate(0, box.y);
      ctx.scale(box.unit, box.unit);
      drawSpeedBars(ctx, 24, 80, values, "left", true);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [values]);
  return <canvas ref={canvas} className="analysis-canvas" aria-label="Speed dwell histogram" />;
}
