/** The six feature-space projections with brush/lasso cutting and E/F picking. */
import { useEffect, useRef, useState } from "react";
import {
  projectionFrame,
  FEATURE_PLOT,
  FEATURE_GAP,
  FEATURE_STRIDE,
  featureGridSize,
  featurePlotOrigin,
} from "./plot-geometry";
import { ClusterGPU, projections } from "./cluster-gpu";
import { type ViewData, type Settings, type FeatureCoordinates } from "../types";

// Feature axes span the middle FEATURE_SPAN of each square projection frame
// (FEATURE_MARGIN either side), matching the cluster shader's x*1.86-.93.
const FEATURE_MARGIN = 0.035;
const FEATURE_SPAN = 0.93;

/** The projection index under a point in the grid, or null over a gap or edge. */
function plotUnder([x, y]: number[], columns: number) {
  const col = Math.floor(x / FEATURE_STRIDE);
  const plot = Math.floor(y / FEATURE_STRIDE) * columns + col;
  const inFrame = x % FEATURE_STRIDE < FEATURE_PLOT && y % FEATURE_STRIDE < FEATURE_PLOT;
  return col < columns && plot < projections.length && inFrame ? plot : null;
}

/** The group of the displayed spike nearest a point (within 5 px), preferring the
 * focused group on ties and skipping hidden spikes. */
function nearestGroup(
  data: ViewData,
  coordinates: FeatureCoordinates,
  [px, py]: number[],
  plot: number,
  columns: number,
  { selected, isolate, range }: { selected: number; isolate: boolean; range: number[] },
) {
  const [ax, ay] = projections[plot];
  const frame = projectionFrame(FEATURE_PLOT, FEATURE_PLOT);
  const origin = featurePlotOrigin(plot, columns);
  const timeScale = 1 / Math.max(1, data.times[data.times.length - 1] || 0);
  const scale = coordinates.values instanceof Uint8Array ? 1 / 255 : 1;
  let group: number | null = null;
  let best = 25;
  for (let i = 0; i < data.labels.length; i++) {
    const label = data.labels[i];
    const time = data.times[i] * timeScale;
    if ((isolate && label !== selected) || time < range[0] || time > range[1]) {
      continue;
    }
    const fx = FEATURE_MARGIN + FEATURE_SPAN * coordinates.values[i * 4 + ax] * scale;
    const fy = 1 - FEATURE_MARGIN - FEATURE_SPAN * coordinates.values[i * 4 + ay] * scale;
    const x = origin.x + frame.x + fx * frame.width;
    const y = origin.y + frame.y + fy * frame.height;
    const distance = (px - x) ** 2 + (py - y) ** 2;
    if (distance < best || (distance === best && label === selected)) {
      group = label;
      best = distance;
    }
  }
  return group;
}

/** Stroke points (pixels in the grid) as normalised feature values in one plot. */
function toFeatureSpace(points: number[][], plot: number, columns: number) {
  const origin = featurePlotOrigin(plot, columns);
  const frame = projectionFrame(FEATURE_PLOT, FEATURE_PLOT);
  // Permit the visible margin around the unit box, so a lasso can enclose
  // extrema at exactly 0 or 1 (particularly common after PCA scaling).
  const clamp = (v: number) => Math.max(-0.05, Math.min(1.05, v));
  return points.flatMap(([x, y]) => [
    clamp(((x - origin.x - frame.x) / frame.width - FEATURE_MARGIN) / FEATURE_SPAN),
    clamp(1 - ((y - origin.y - frame.y) / frame.height - FEATURE_MARGIN) / FEATURE_SPAN),
  ]);
}

export function Clusters({
  data,
  coordinates,
  settings,
  selected,
  isolate,
  range,
  tool,
  onPolygon,
  onPick,
}: {
  data: ViewData;
  coordinates: FeatureCoordinates;
  settings: Settings;
  selected: number;
  isolate: boolean;
  range: number[];
  tool: string;
  onPolygon: (p: number[], ax: number, ay: number) => void;
  onPick: (group: number, source: boolean, toggle: boolean) => void;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const axes = projections;

  // Projections per row (from the pane width), and a counter that forces a
  // redraw after resizes or a restored WebGL context.
  const [columns, setColumns] = useState(2);
  const [version, setVersion] = useState(0);
  const gpu = useRef<ClusterGPU | null>(null);
  const [error, setError] = useState("");

  // The brush/lasso stroke being drawn (state for the overlay, ref for events),
  // and the last pointer position for E/F picking.
  const [stroke, setStroke] = useState<number[][]>([]);
  const drawing = useRef<{ plot: number; points: number[][] } | null>(null);
  const pointer = useRef<number[] | null>(null);

  useEffect(() => {
    // Find the nearest spike only when E/F is pressed, never on every move.
    // Picking respects the focused group's foreground and displayed time range.
    const pick = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const p = pointer.current;
      const modified = event.ctrlKey || event.metaKey || event.altKey;
      const typing = (event.target as HTMLElement).matches("input,select,textarea");
      if (!p || drawing.current || event.repeat || tool === "disabled") {
        return;
      }
      if (!["e", "f"].includes(key) || modified || typing) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const plot = plotUnder(p, columns);
      if (plot === null) {
        return;
      }
      const group = nearestGroup(data, coordinates, p, plot, columns, { selected, isolate, range });
      if (group !== null) {
        onPick(group, key === "f", event.shiftKey);
      }
    };
    window.addEventListener("keydown", pick, true);
    return () => window.removeEventListener("keydown", pick, true);
  }, [data, coordinates, selected, isolate, range, columns, tool, onPick, axes]);
  useEffect(() => {
    const c = canvas.current!;
    const restore = () => setVersion((v) => v + 1);
    const lost = (e: Event) => {
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
      const width = wrapper.current!.parentElement!.clientWidth;
      setColumns(Math.max(1, Math.min(6, Math.floor((width + FEATURE_GAP) / FEATURE_STRIDE))));
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
      if (!gpu.current && canvas.current) {
        gpu.current = new ClusterGPU(canvas.current);
      }
      gpu.current?.draw(data, coordinates, settings, selected, isolate, range, axes, columns);
    } catch (e) {
      setError(String(e));
    }
    // Only point size and colour mode affect the points; other settings (rate maps,
    // analysis windows) must not redraw the whole population.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only point size and colour mode among the settings affect the drawn points
  }, [
    data,
    coordinates,
    settings.pointSize,
    settings.renderMode,
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
  const startStroke = (e: React.PointerEvent) => {
    if (e.button !== 0 || (tool !== "lasso" && tool !== "brush")) {
      return;
    }
    const p = point(e);
    const plot = plotUnder(p, columns);
    if (plot === null || p[0] >= grid.width || p[1] >= grid.height) {
      return;
    }
    drawing.current = { plot, points: [p] };
    setStroke([p]);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const extendStroke = (e: React.PointerEvent) => {
    pointer.current = point(e);
    if (drawing.current) {
      drawing.current.points.push(pointer.current);
      setStroke([...drawing.current.points]);
    }
  };
  // A lasso needs at least a triangle; a brush can be a single dab.
  const finishStroke = () => {
    const d = drawing.current;
    drawing.current = null;
    setStroke([]);
    if (!d || (tool !== "brush" && d.points.length < 3)) {
      return;
    }
    onPolygon(toFeatureSpace(d.points, d.plot, columns), axes[d.plot][0], axes[d.plot][1]);
  };
  return (
    <div
      className="clusters"
      ref={wrapper}
      data-columns={columns}
      data-features={coordinates.mode}
      data-colour-mode={settings.renderMode}
      data-feature-key={coordinates.key}
      style={grid}
      onPointerDown={startStroke}
      onPointerMove={extendStroke}
      onPointerLeave={() => {
        pointer.current = null;
      }}
      onPointerUp={finishStroke}
    >
      <canvas ref={canvas} style={grid} aria-label="Six WebGL2 spike feature projections" />
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
          <div
            key={i}
            data-x-axis={`${coordinates.mode === "pca" ? "PC" : "A"}${x + 1}`}
            data-y-axis={`${coordinates.mode === "pca" ? "PC" : "A"}${y + 1}`}
          >
            <span className="axis-y">
              {coordinates.mode === "pca" ? "PC" : "A"}
              {y + 1}
            </span>
            <span className="axis-x">
              {coordinates.mode === "pca" ? "PC" : "A"}
              {x + 1}
            </span>
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
  const source = document.querySelector<HTMLCanvasElement>(".clusters canvas");
  const root = source?.closest<HTMLElement>(".clusters");
  if (!source || !root) {
    return;
  }
  const columns = Number(root.dataset.columns);
  const scale = source.width / source.clientWidth;
  const copy = document.createElement("canvas");
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
