import { useEffect, useRef, useState } from "react";
import type { LfpDistribution } from "../types";
import { drawSpeedBars } from "./SpeedPlot";
import { fitGrid } from "./plot-geometry";

/** The spike phase plots' blue. */
export const PHASE_BLUE = "#1565c0";
/** The frequency plot's blue: lighter than the phase plots', as they show different things. */
export const FREQUENCY_BLUE = "#42a5f5";

/** Time at each instantaneous frequency of the band-passed `.egf` signal over the recording,
 * drawn like the speed dwell above it: bars from a left axis, the band's low edge at the top
 * and its high edge at the bottom. Hovered, its axis ends and the mean frequency are shown. */
export function LfpFrequencyPlot({ data }: { data: LfpDistribution }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState(false);
  const { values, low, bin, mean } = data;
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
      // As wide as the speed dwell, but shorter; inset for its outline (2 px).
      const box = fitGrid(w - 2, h - 4, 24, 60);
      ctx.translate(2, box.y + 2);
      ctx.scale(box.unit, box.unit);
      drawSpeedBars(ctx, 24, 60, values, "left", FREQUENCY_BLUE, {
        bar: FREQUENCY_BLUE,
        axisWidth: 1.5,
        halo: 2 / box.unit,
      });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [values]);
  const hz = (f: number) => f.toFixed(2).replace(/\.?0+$/, "");
  return (
    <div
      className="lfp-frequency"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <canvas ref={canvas} className="analysis-canvas" aria-label="LFP frequency distribution" />
      {hovered && (
        <>
          <span className="axis-label lfp-label top">{hz(low)} Hz</span>
          <span className="axis-label lfp-label bottom">{hz(low + values.length * bin)} Hz</span>
          <span className="axis-label lfp-label below-left">
            {Number.isFinite(mean) ? `mean ${mean.toFixed(1)} Hz` : "no signal in band"}
          </span>
        </>
      )}
    </div>
  );
}
