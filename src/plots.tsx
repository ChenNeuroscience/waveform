import { useEffect, useRef, useState } from "react";
import {
  fitGrid,
  projectionFrame,
  FEATURE_PLOT,
  FEATURE_GAP,
  FEATURE_STRIDE,
  featureGridSize,
  featurePlotOrigin,
} from "./plot-geometry";
import { ClusterGPU, projections } from "./gpu";
import {
  color,
  type ViewData,
  type Settings,
  type AnalysisData,
  type PlotMode,
  type Trajectory,
} from "./types";
export function Clusters({
  data,
  settings,
  selected,
  isolate,
  range,
  tool,
  onPolygon,
  onPick,
}: {
  data: ViewData;
  settings: Settings;
  selected: number;
  isolate: boolean;
  range: number[];
  tool: string;
  onPolygon: (p: number[], ax: number, ay: number) => void;
  onPick: (group: number, source: boolean, toggle: boolean) => void;
}) {
  const wrapper = useRef<HTMLDivElement>(null),
    [columns, setColumns] = useState(2),
    canvas = useRef<HTMLCanvasElement>(null),
    gpu = useRef<ClusterGPU | null>(null),
    [error, setError] = useState(""),
    axes = projections,
    [stroke, setStroke] = useState<number[][]>([]),
    drawing = useRef<{ plot: number; points: number[][] } | null>(null),
    pointer = useRef<number[] | null>(null),
    [version, setVersion] = useState(0);
  useEffect(() => {
    // Resolve the sampled cloud only when E/F is pressed, never on every move.
    // Picking respects the focused group's foreground and displayed time range.
    const pick = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase(),
        p = pointer.current;
      if (
        !p ||
        drawing.current ||
        event.repeat ||
        tool === "disabled" ||
        !["e", "f"].includes(key) ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target as HTMLElement).matches("input,select,textarea")
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const col = Math.floor(p[0] / FEATURE_STRIDE),
        row = Math.floor(p[1] / FEATURE_STRIDE),
        plot = row * columns + col,
        frame = projectionFrame(FEATURE_PLOT, FEATURE_PLOT),
        origin = featurePlotOrigin(plot, columns);
      if (
        col >= columns ||
        plot >= axes.length ||
        p[0] % FEATURE_STRIDE >= FEATURE_PLOT ||
        p[1] % FEATURE_STRIDE >= FEATURE_PLOT
      )
        return;
      const [ax, ay] = axes[plot];
      let group: number | null = null,
        best = 25;
      const timeScale = 1 / Math.max(1, data.times[data.times.length - 1] || 0);
      for (let i = 0; i < data.labels.length; i++) {
        const label = data.labels[i],
          time = data.times[i] * timeScale;
        if (
          (isolate && label !== selected) ||
          time < range[0] ||
          time > range[1]
        )
          continue;
        const x =
            origin.x +
            frame.x +
            (0.035 + (0.93 * data.features[i * 4 + ax]) / 255) * frame.width,
          y =
            origin.y +
            frame.y +
            (0.965 - (0.93 * data.features[i * 4 + ay]) / 255) * frame.height,
          distance = (p[0] - x) ** 2 + (p[1] - y) ** 2;
        if (distance < best || (distance === best && label === selected)) {
          group = label;
          best = distance;
        }
      }
      if (group !== null) onPick(group, key === "f", event.shiftKey);
    };
    window.addEventListener("keydown", pick, true);
    return () => window.removeEventListener("keydown", pick, true);
  }, [data, selected, isolate, range, columns, tool, onPick, axes]);
  useEffect(() => {
    const c = canvas.current!;
    const restore = () => setVersion((v) => v + 1),
      lost = (e: Event) => {
        e.preventDefault();
        gpu.current = null;
      };
    c.addEventListener("webglcontextlost", lost);
    c.addEventListener("webglcontextrestored", restore);
    try {
      gpu.current = new ClusterGPU(c);
    } catch (e) {
      setError(String(e));
    }
    const ro = new ResizeObserver(() => {
      setColumns(
        Math.max(
          1,
          Math.min(
            6,
            Math.floor(
              (wrapper.current!.parentElement!.clientWidth + FEATURE_GAP) /
                FEATURE_STRIDE,
            ),
          ),
        ),
      );
      setVersion((v) => v + 1);
    });
    ro.observe(wrapper.current!.parentElement!);
    return () => {
      ro.disconnect();
      gpu.current?.dispose();
      c.removeEventListener("webglcontextlost", lost);
      c.removeEventListener("webglcontextrestored", restore);
    };
  }, []);
  useEffect(() => {
    try {
      if (!gpu.current && canvas.current)
        gpu.current = new ClusterGPU(canvas.current);
      gpu.current?.draw(
        data,
        settings,
        selected,
        isolate,
        range,
        axes,
        columns,
      );
    } catch (e) {
      setError(String(e));
    }
    // Only point size and drift affect the points; other settings (rate maps,
    // analysis windows) must not redraw the whole population.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only point size and drift among the settings affect the drawn points
  }, [
    data,
    settings.pointSize,
    settings.drift,
    selected,
    isolate,
    range,
    axes,
    version,
    columns,
  ]);
  const grid = featureGridSize(columns);
  const point = (e: React.PointerEvent) => {
    const b = e.currentTarget.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top];
  };
  return (
    <div
      className="clusters"
      ref={wrapper}
      data-columns={columns}
      style={grid}
      onPointerDown={(e) => {
        if (e.button !== 0 || (tool !== "lasso" && tool !== "brush")) return;
        const p = point(e),
          plot =
            Math.floor(p[1] / FEATURE_STRIDE) * columns +
            Math.floor(p[0] / FEATURE_STRIDE);
        if (
          p[0] >= grid.width ||
          p[1] >= grid.height ||
          p[0] % FEATURE_STRIDE >= FEATURE_PLOT ||
          p[1] % FEATURE_STRIDE >= FEATURE_PLOT ||
          plot >= 6
        )
          return;
        drawing.current = { plot, points: [p] };
        setStroke([p]);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        pointer.current = point(e);
        if (!drawing.current) return;
        const p = point(e);
        drawing.current.points.push(p);
        setStroke([...drawing.current.points]);
      }}
      onPointerLeave={() => {
        pointer.current = null;
      }}
      onPointerUp={(e) => {
        const d = drawing.current;
        drawing.current = null;
        setStroke([]);
        if (!d) return;
        const origin = featurePlotOrigin(d.plot, columns),
          frame = projectionFrame(FEATURE_PLOT, FEATURE_PLOT),
          points = d.points;
        if (tool !== "brush" && points.length < 3) return;
        const poly = points.flatMap(([x, y]) => [
          Math.max(
            0,
            Math.min(
              1,
              ((x - origin.x - frame.x) / frame.width - 0.035) / 0.93,
            ),
          ),
          Math.max(
            0,
            Math.min(
              1,
              1 - ((y - origin.y - frame.y) / frame.height - 0.035) / 0.93,
            ),
          ),
        ]);
        onPolygon(poly, axes[d.plot][0], axes[d.plot][1]);
      }}
    >
      <canvas
        ref={canvas}
        style={grid}
        aria-label="Six WebGL2 spike feature projections"
      />
      <div
        className="projection-labels"
        style={{
          ...grid,
          gap: FEATURE_GAP,
          gridTemplateColumns: `repeat(${columns},${FEATURE_PLOT}px)`,
          gridTemplateRows: `repeat(${Math.ceil(6 / columns)},${FEATURE_PLOT}px)`,
        }}
      >
        {axes.map(([x, y], i) => (
          <div key={i} data-x-axis={`A${x + 1}`} data-y-axis={`A${y + 1}`}>
            <span className="axis-y">A{y + 1}</span>
            <span className="axis-x">A{x + 1}</span>
          </div>
        ))}
      </div>
      {stroke.length > 0 && (
        <svg className="lasso-overlay">
          <polyline
            points={stroke.map((p) => p.join(",")).join(" ")}
            fill={tool === "brush" ? "none" : "rgba(103,217,188,.12)"}
            stroke="#8ce6cc"
            strokeWidth={tool === "brush" ? 18 : 1.5}
            strokeOpacity={tool === "brush" ? 0.3 : 1}
          />
        </svg>
      )}
      {error && <div className="plot-error">{error}</div>}
    </div>
  );
}
export function captureFeatureGrid(): HTMLCanvasElement | undefined {
  const source = document.querySelector<HTMLCanvasElement>(".clusters canvas"),
    root = source?.closest<HTMLElement>(".clusters");
  if (!source || !root) return;
  const columns = Number(root.dataset.columns),
    scale = source.width / source.clientWidth,
    copy = document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  const ctx = copy.getContext("2d")!;
  ctx.drawImage(source, 0, 0);
  ctx.scale(scale, scale);
  ctx.font = "9px Arial";
  for (const [i, label] of [
    ...root.querySelectorAll<HTMLElement>(".projection-labels>div"),
  ].entries()) {
    const { x, y } = featurePlotOrigin(i, columns);
    ctx.strokeStyle = "#bbb";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, FEATURE_PLOT - 1, FEATURE_PLOT - 1);
    ctx.fillStyle = "#ffffffe8";
    ctx.fillRect(x + 2, y + 2, 20, 13);
    ctx.fillRect(x + 106, y + 113, 20, 13);
    ctx.fillStyle = "#333";
    ctx.textAlign = "left";
    ctx.fillText(label.dataset.yAxis || "", x + 4, y + 12);
    ctx.textAlign = "right";
    ctx.fillText(label.dataset.xAxis || "", x + 124, y + 124);
  }
  return copy;
}
export function AnalysisPlot({
  data,
  mode,
  maxRate,
  compact = false,
  speedAlignment = "right",
  positionSpeed = false,
}: {
  data: AnalysisData;
  mode: PlotMode;
  maxRate: number;
  compact?: boolean;
  speedAlignment?: "left" | "right";
  positionSpeed?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current!,
      draw = () => {
        const dpr = Math.min(2, devicePixelRatio || 1);
        c.width = c.clientWidth * dpr;
        c.height = c.clientHeight * dpr;
        const ctx = c.getContext("2d")!;
        ctx.scale(dpr, dpr);
        let w = c.clientWidth,
          h = c.clientHeight;
        ctx.fillStyle = "#ffffff";
        if (!positionSpeed) ctx.fillRect(0, 0, w, h);
        if (compact && (mode === "ac" || mode === "speed")) {
          const box = fitGrid(
            w,
            h,
            mode === "ac" ? 128 : 24,
            mode === "ac" ? 32 : 80,
          );
          ctx.translate(
            mode === "speed" && speedAlignment === "left" ? 0 : box.x,
            box.y,
          );
          ctx.scale(box.unit, box.unit);
          w = mode === "ac" ? 128 : 24;
          h = mode === "ac" ? 32 : 80;
        }
        if (mode === "spatial") {
          const scale = maxRate || data.peak || 1,
            box = fitGrid(w, h, data.width, data.height),
            ww = box.unit,
            hh = box.unit;
          for (let i = 0; i < data.spatial.length; i++) {
            const v = data.spatial[i];
            ctx.fillStyle = Number.isFinite(v)
              ? `hsl(${240 - Math.min(1, v / scale) * 240} 100% 50%)`
              : "#ffffff";
            ctx.fillRect(
              box.x + (i % data.width) * ww,
              box.y + Math.floor(i / data.width) * hh,
              ww + 0.5,
              hh + 0.5,
            );
          }
        } else if (mode === "direction") {
          const a = data.direction,
            max = Math.max(...a, 1),
            r = Math.min(w, h) * 0.4,
            cx = w / 2,
            cy = h / 2;
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
            const j = i % a.length,
              theta = (j / a.length) * Math.PI * 2 - Math.PI,
              rr = (a[j] / max) * r,
              x = cx + Math.cos(theta) * rr,
              y = cy + Math.sin(theta) * rr;
            if (!i) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else if (compact) {
          const a =
              mode === "ac"
                ? data.ac
                : positionSpeed
                  ? data.speedDwell
                  : data.speed,
            max = Math.max(...a, 1);
          if (mode === "ac") {
            ctx.strokeStyle = "#f00000";
            ctx.lineWidth = 0.7;
            ctx.beginPath();
            for (let i = 0; i < a.length; i++) {
              const x = (i / (a.length - 1)) * (w - 2) + 1,
                y = h - 2 - (a[i] / max) * (h - 4);
              if (!i) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.stroke();
          } else {
            ctx.fillStyle = "#111";
            const bh = h / a.length;
            for (let i = 0; i < a.length; i++) {
              if (!(a[i] > 0)) continue;
              const bw = (a[i] / max) * (w - 1);
              ctx.fillRect(
                speedAlignment === "left" ? 0 : w - bw,
                i * bh,
                bw,
                Math.max(0.5, bh - 0.4),
              );
            }
            if (positionSpeed) {
              ctx.fillStyle = "#f00";
              ctx.fillRect(0, 0, 0.6, h);
            }
          }
        } else {
          const a =
              mode === "ac"
                ? data.ac
                : positionSpeed
                  ? data.speedDwell
                  : data.speed,
            max = Math.max(...a, 1),
            bw = (w - 36) / a.length;
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
          ctx.fillText(
            mode === "ac" ? "lag →" : "speed (cm/s) →",
            w / 2 - 25,
            h - 7,
          );
        }
      };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [data, mode, maxRate, compact, speedAlignment, positionSpeed]);
  return (
    <canvas
      ref={canvas}
      className="analysis-canvas"
      aria-label={mode === "ac" ? "Temporal autocorrelogram" : `${mode} plot`}
    />
  );
}

export interface SpikeLayer {
  cell: number;
  spikes: Float32Array;
  color: string;
}
/** The trajectory with spike overlays. The path is drawn once into an offscreen
 * canvas (per trajectory and size); layer changes, such as hovering a tile, only
 * copy it back and draw the spike dots. One visible canvas keeps copies simple. */
export function PathPlot({
  trajectory,
  layers,
}: {
  trajectory: Trajectory;
  layers: SpikeLayer[];
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    base = useRef<{
      key: string;
      trajectory: Trajectory;
      image: HTMLCanvasElement;
    } | null>(null);
  useEffect(() => {
    const c = canvas.current!,
      draw = () => {
        const dpr = Math.min(2, devicePixelRatio || 1),
          w = c.clientWidth,
          h = c.clientHeight,
          key = `${w}x${h}x${dpr}`,
          // Use the full pane width and start at its top; retain one physical
          // scale for x/y, with any unused space below or beside the arena.
          box = {
            ...fitGrid(w, h, trajectory.arenaWidth, trajectory.arenaHeight),
            y: 0,
          };
        // Hidden or not yet laid out: nothing to draw (and a 0×0 offscreen
        // canvas cannot be copied with drawImage).
        if (!w || !h) return;
        if (
          base.current?.key !== key ||
          base.current.trajectory !== trajectory
        ) {
          const image = document.createElement("canvas");
          image.width = w * dpr;
          image.height = h * dpr;
          const ctx = image.getContext("2d")!,
            path = trajectory.path;
          ctx.scale(dpr, dpr);
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, w, h);
          ctx.strokeStyle = "#333333";
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          for (let i = 0; i < path.length; i += 2) {
            const x = box.x + path[i] * box.width,
              y = box.y + path[i + 1] * box.height;
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          }
          ctx.stroke();
          base.current = { key, trajectory, image };
        }
        c.width = w * dpr;
        c.height = h * dpr;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(base.current.image, 0, 0);
        ctx.scale(dpr, dpr);
        for (const layer of layers) {
          ctx.fillStyle = layer.color;
          for (let i = 0; i < layer.spikes.length; i += 2)
            ctx.fillRect(
              box.x + layer.spikes[i] * box.width,
              box.y + layer.spikes[i + 1] * box.height,
              1.6,
              1.6,
            );
        }
      };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [trajectory, layers]);
  return (
    <canvas ref={canvas} className="analysis-canvas" aria-label="path plot" />
  );
}
