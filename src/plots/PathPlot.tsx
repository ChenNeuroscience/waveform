import { useEffect, useRef } from "react";
import { fitGrid } from "./plot-geometry";
import { type Trajectory } from "../types";

export interface SpikeLayer {
  cell: number;
  spikes: Float32Array;
  color: string;
}
function pathBox(w: number, h: number, trajectory: Trajectory) {
  return { ...fitGrid(w, h, trajectory.arenaWidth, trajectory.arenaHeight), y: 0 };
}

/** Shared by the live pane and clipboard exports, in CSS-pixel coordinates. */
export function drawPathBase(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  trajectory: Trajectory,
) {
  const box = pathBox(w, h, trajectory);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#333333";
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (let i = 0; i < trajectory.path.length; i += 2) {
    const x = box.x + trajectory.path[i] * box.width;
    const y = box.y + trajectory.path[i + 1] * box.height;
    if (i) {
      ctx.lineTo(x, y);
    } else {
      ctx.moveTo(x, y);
    }
  }
  ctx.stroke();
}

export function drawSpikeLayers(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  trajectory: Trajectory,
  layers: SpikeLayer[],
) {
  const box = pathBox(w, h, trajectory);
  for (const layer of layers) {
    ctx.fillStyle = layer.color;
    for (let i = 0; i < layer.spikes.length; i += 2) {
      ctx.fillRect(
        Math.round(box.x + layer.spikes[i] * box.width) - 1,
        Math.round(box.y + layer.spikes[i + 1] * box.height) - 1,
        3,
        3,
      );
    }
  }
}

/** The trajectory with spike overlays. The path is drawn once into an offscreen
 * canvas (per trajectory and size); layer changes, such as hovering a tile, only
 * copy it back and draw the spike dots. One visible canvas keeps copies simple. */
export function PathPlot({ trajectory, layers }: { trajectory: Trajectory; layers: SpikeLayer[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const base = useRef<{
    key: string;
    trajectory: Trajectory;
    image: HTMLCanvasElement;
  } | null>(null);
  useEffect(() => {
    const c = canvas.current!;
    const draw = () => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = c.clientWidth;
      const h = c.clientHeight;
      const key = `${w}x${h}x${dpr}`;
      // Hidden or not yet laid out: nothing to draw (and a 0×0 offscreen
      // canvas cannot be copied with drawImage).
      if (!w || !h) {
        return;
      }
      if (base.current?.key !== key || base.current.trajectory !== trajectory) {
        const image = document.createElement("canvas");
        image.width = w * dpr;
        image.height = h * dpr;
        const ctx = image.getContext("2d")!;
        ctx.scale(dpr, dpr);
        drawPathBase(ctx, w, h, trajectory);
        base.current = { key, trajectory, image };
      }
      c.width = w * dpr;
      c.height = h * dpr;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(base.current.image, 0, 0);
      ctx.scale(dpr, dpr);
      drawSpikeLayers(ctx, w, h, trajectory, layers);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [trajectory, layers]);
  return <canvas ref={canvas} className="analysis-canvas" aria-label="path plot" />;
}
