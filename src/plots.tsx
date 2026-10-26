import { useEffect, useRef, useState } from "react";
import { usePreference } from "./preferences";
import { fitGrid, projectionFrame } from "./plot-geometry";
import { ClusterGPU, drawWaves, drawWaveOverview, projections } from "./gpu";
import {
  color,
  type ViewData,
  type Settings,
  type AnalysisData,
  type PlotMode,
} from "./types";
export function Clusters({
  data,
  settings,
  selected,
  isolate,
  range,
  tool,
  onPolygon,
}: {
  data: ViewData;
  settings: Settings;
  selected: number;
  isolate: boolean;
  range: number[];
  tool: string;
  onPolygon: (p: number[], ax: number, ay: number) => void;
}) {
  const wrapper = useRef<HTMLDivElement>(null),
    [columns, setColumns] = useState(2),
    canvas = useRef<HTMLCanvasElement>(null),
    gpu = useRef<ClusterGPU | null>(null),
    [error, setError] = useState(""),
    axes = projections,
    [stroke, setStroke] = useState<number[][]>([]),
    drawing = useRef<{ plot: number; points: number[][] } | null>(null),
    [version, setVersion] = useState(0);
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
          Math.min(6, Math.floor(wrapper.current!.clientWidth / 128)),
        ),
      );
      setVersion((v) => v + 1);
    });
    ro.observe(wrapper.current!);
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
  }, [data, settings, selected, isolate, range, axes, version, columns]);
  const point = (e: React.PointerEvent) => {
    const b = e.currentTarget.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top];
  };
  return (
    <div
      className="clusters"
      ref={wrapper}
      data-columns={columns}
      style={{ height: Math.ceil(6 / columns) * 128 }}
      onPointerDown={(e) => {
        if (tool !== "lasso" && tool !== "brush") return;
        const p = point(e),
          plot = Math.floor(p[1] / 128) * columns + Math.floor(p[0] / 128);
        if (p[0] >= columns * 128 || plot >= 6) return;
        drawing.current = { plot, points: [p] };
        setStroke([p]);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drawing.current) return;
        const p = point(e);
        drawing.current.points.push(p);
        setStroke([...drawing.current.points]);
      }}
      onPointerUp={(e) => {
        const d = drawing.current;
        drawing.current = null;
        setStroke([]);
        if (!d) return;
        const w = 128,
          h = 128,
          col = d.plot % columns,
          row = Math.floor(d.plot / columns),
          frame = projectionFrame(w, h),
          points = d.points;
        if (tool !== "brush" && points.length < 3) return;
        const poly = points.flatMap(([x, y]) => [
          Math.max(
            0,
            Math.min(1, ((x - col * w - frame.x) / frame.width - 0.035) / 0.93),
          ),
          Math.max(
            0,
            Math.min(
              1,
              1 - ((y - row * h - frame.y) / frame.height - 0.035) / 0.93,
            ),
          ),
        ]);
        onPolygon(poly, axes[d.plot][0], axes[d.plot][1]);
      }}
    >
      <canvas
        ref={canvas}
        style={{ width: columns * 128, height: Math.ceil(6 / columns) * 128 }}
        aria-label="Six WebGL2 spike feature projections"
      />
      <div
        className="projection-labels"
        style={{
          width: columns * 128,
          height: Math.ceil(6 / columns) * 128,
          gridTemplateColumns: `repeat(${columns},128px)`,
          gridTemplateRows: `repeat(${Math.ceil(6 / columns)},128px)`,
        }}
      >
        {axes.map(([x, y], i) => (
          <div key={i} data-x-axis={`A${x + 1}`} data-y-axis={`A${y + 1}`}>
            <span className="axis-y">A{y + 1}</span>
            <span className="axis-x">A{x + 1}</span>
          </div>
        ))}
      </div>
      {data.features.length / 4 < data.n && (
        <span className="sampling-warning">
          WARNING: using sampled rendering
        </span>
      )}
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
    const x = (i % columns) * 128,
      y = Math.floor(i / columns) * 128;
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
export function WavePlot({ data, cell }: { data: ViewData; cell: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => drawWaves(ref.current!, data, cell), [data, cell]);
  return (
    <div className="wave-plot">
      <div className="channel-labels">
        {[1, 2, 3, 4].map((c) => (
          <span key={c}>CH {c}</span>
        ))}
      </div>
      <canvas ref={ref} aria-label={`Sampled waveforms for cell ${cell}`} />
      <small>
        50 samples / channel ·{" "}
        {data.waveLabels.filter((c) => c === cell).length} sampled spikes
      </small>
    </div>
  );
}
export function WaveformGate({
  disabled,
  onGate,
}: {
  disabled: boolean;
  onGate: (
    channel: number,
    sample: number,
    threshold: number,
    above: boolean,
  ) => void;
}) {
  const [gate, setGate] = usePreference("waveform-gate", {
    channel: 0,
    sample: 14,
    threshold: 40,
    above: true,
  });
  const { channel, sample, threshold, above } = gate,
    setChannel = (channel: number) => setGate((g) => ({ ...g, channel })),
    setSample = (sample: number) => setGate((g) => ({ ...g, sample })),
    setThreshold = (threshold: number) => setGate((g) => ({ ...g, threshold })),
    setAbove = (above: boolean) => setGate((g) => ({ ...g, above }));
  return (
    <details className="wave-gate">
      <summary>Split by waveform sample</summary>
      <p>
        Apply a sample threshold to every spike in the chosen source cells. The
        first use reads one waveform column; repeated cuts reuse it.
      </p>
      <div>
        <label>
          Channel
          <select
            aria-label="Gate channel"
            value={channel}
            onChange={(e) => setChannel(+e.target.value)}
          >
            {[0, 1, 2, 3].map((c) => (
              <option key={c} value={c}>
                {c + 1}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sample
          <input
            aria-label="Gate sample"
            type="number"
            value={sample}
            min="0"
            max="49"
            onChange={(e) =>
              setSample(Math.max(0, Math.min(49, +e.target.value)))
            }
          />
        </label>
        <label>
          Threshold
          <input
            aria-label="Gate threshold"
            type="number"
            value={threshold}
            min="-128"
            max="127"
            onChange={(e) =>
              setThreshold(Math.max(-128, Math.min(127, +e.target.value)))
            }
          />
        </label>
        <label>
          Move
          <select
            aria-label="Gate direction"
            value={above ? "above" : "below"}
            onChange={(e) => setAbove(e.target.value === "above")}
          >
            <option value="above">At or above</option>
            <option value="below">Below</option>
          </select>
        </label>
        <button
          className="secondary"
          disabled={disabled}
          onClick={() => onGate(channel, sample, threshold, above)}
        >
          Apply split
        </button>
      </div>
    </details>
  );
}
export function CellOverview({
  data,
  selected,
  onSelect,
}: {
  data: ViewData;
  selected: number;
  onSelect: (n: number) => void;
}) {
  const [page, setPage] = useState(0),
    [open, setOpen] = useState(false),
    [cols, setCols] = useState(3),
    [version, setVersion] = useState(0),
    ref = useRef<HTMLCanvasElement>(null);
  const ids = Array.from(data.counts, (n, i) => ({ n, i }))
      .filter((c) => c.n > 0)
      .map((c) => c.i),
    pages = Math.ceil(ids.length / 12),
    cells = ids.slice(
      Math.min(page, pages - 1) * 12,
      (Math.min(page, pages - 1) + 1) * 12,
    );
  useEffect(() => {
    if (!open || !ref.current) return;
    const ro = new ResizeObserver(() => {
      setCols(ref.current!.clientWidth < 500 ? 2 : 3);
      setVersion((v) => v + 1);
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [open]);
  useEffect(() => {
    if (open && ref.current)
      return drawWaveOverview(ref.current, data, cells, cols);
  }, [data, open, page, cols, version]);
  return (
    <div className="panel overview-panel">
      <div className="panel-heading">
        <button className="overview-toggle" onClick={() => setOpen(!open)}>
          <span>{open ? "▾" : "▸"}</span> Cell overview{" "}
          <small>{ids.length} groups · sampled waveforms</small>
        </button>
        {open && (
          <div className="overview-pages">
            <button
              disabled={page <= 0}
              aria-label="Previous cell page"
              onClick={() => setPage((p) => p - 1)}
            >
              ←
            </button>
            <small>
              {page + 1} / {pages}
            </small>
            <button
              disabled={page >= pages - 1}
              aria-label="Next cell page"
              onClick={() => setPage((p) => p + 1)}
            >
              →
            </button>
          </div>
        )}
      </div>
      {open && (
        <div
          className="wave-overview"
          style={{ height: Math.ceil(cells.length / cols) * 120 }}
        >
          <canvas
            ref={ref}
            aria-label="Waveform overview rendered in one WebGL2 context"
          />
          <div
            className="wave-overview-labels"
            style={{ gridTemplateColumns: `repeat(${cols},1fr)` }}
          >
            {cells.map((c) => (
              <button
                key={c}
                className={c === selected ? "selected" : ""}
                onClick={() => onSelect(c)}
                aria-label={`Inspect overview cell ${c}`}
              >
                <b style={{ color: color(c) }}>
                  Cell {String(c).padStart(2, "0")}
                </b>
                <small>{data.counts[c].toLocaleString()} spikes</small>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
export function AnalysisPlot({
  data,
  mode,
  maxRate,
  compact = false,
  spikeLayers,
  speedAlignment = "right",
  positionSpeed = false,
}: {
  data: AnalysisData;
  mode: PlotMode | "path";
  maxRate: number;
  compact?: boolean;
  speedAlignment?: "left" | "right";
  positionSpeed?: boolean;
  spikeLayers?: { cell: number; spikes: Float32Array; color: string }[];
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
        } else if (mode === "path") {
          const box = fitGrid(
            w,
            h,
            data.arenaWidth || data.width,
            data.arenaHeight || data.height,
          );
          // Use the full pane width and start at its top; retain one physical
          // scale for x/y, with any unused space below or beside the arena.
          box.y = 0;
          ctx.strokeStyle = "#333333";
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          for (let i = 0; i < data.path.length; i += 2) {
            const x = box.x + data.path[i] * box.width,
              y = box.y + data.path[i + 1] * box.height;
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          }
          ctx.stroke();
          for (const layer of spikeLayers || [
            { spikes: data.spikes, color: "#0044cc" },
          ]) {
            ctx.fillStyle = layer.color;
            for (let i = 0; i < layer.spikes.length; i += 2)
              ctx.fillRect(
                box.x + layer.spikes[i] * box.width,
                box.y + layer.spikes[i + 1] * box.height,
                1.6,
                1.6,
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
              ctx.fillRect(0, h - 0.6, w, 0.6);
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
  }, [
    data,
    mode,
    maxRate,
    compact,
    spikeLayers,
    speedAlignment,
    positionSpeed,
  ]);
  return (
    <canvas
      ref={canvas}
      className="analysis-canvas"
      aria-label={mode === "ac" ? "Temporal autocorrelogram" : `${mode} plot`}
    />
  );
}
