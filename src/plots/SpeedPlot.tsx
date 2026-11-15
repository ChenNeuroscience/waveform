import { useEffect, useRef } from "react";
import { fitGrid } from "./plot-geometry";

/** Shared bars for compact speed tuning, position-only speed dwell and LFP phase plots.
 * `axis` draws the baseline: red, or the colour given. Options: the bars' colour (near-black
 * by default), the axis's width, and a white outline `halo` wide around bars and axis, for
 * drawing over the path. */
export function drawSpeedBars(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  values: Float32Array,
  alignment: "left" | "right",
  axis: boolean | string,
  {
    bar = "#111",
    axisWidth = 0.6,
    halo = 0,
  }: { bar?: string; axisWidth?: number; halo?: number } = {},
) {
  const max = Math.max(...values, 1);
  const bh = h / values.length;
  const bars: [number, number, number, number][] = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] > 0) {
      const bw = (values[i] / max) * (w - 1);
      bars.push([alignment === "left" ? 0 : w - bw, i * bh, bw, Math.max(0.5, bh - 0.4)]);
    }
  }
  if (halo) {
    ctx.fillStyle = "white";
    for (const [x, y, bw, height] of bars) {
      ctx.fillRect(x - halo, y - halo, bw + 2 * halo, height + 2 * halo);
    }
    if (axis) {
      ctx.fillRect(-halo, -halo, axisWidth + 2 * halo, h + 2 * halo);
    }
  }
  ctx.fillStyle = bar;
  for (const [x, y, bw, height] of bars) {
    ctx.fillRect(x, y, bw, height);
  }
  if (axis) {
    ctx.fillStyle = typeof axis === "string" ? axis : "#f00";
    ctx.fillRect(0, 0, axisWidth, h);
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
      // Inset for the outline (2 px) that keeps the bars clear of the path behind.
      const box = fitGrid(w - 2, h - 4, 24, 80);
      ctx.translate(2, box.y + 2);
      ctx.scale(box.unit, box.unit);
      // A heavier axis than the tiles': its colour keys the scale in the pane's foot.
      drawSpeedBars(ctx, 24, 80, values, "left", true, { axisWidth: 1.5, halo: 2 / box.unit });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [values]);
  return <canvas ref={canvas} className="analysis-canvas" aria-label="Speed dwell histogram" />;
}
