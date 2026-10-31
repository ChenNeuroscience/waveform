import { RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FeatureCoordinates, FeatureProjection, Settings, ViewData } from "../types";
import { ClusterGPU } from "./cluster-gpu";
import {
  clusterProjection,
  DEFAULT_CLUSTER_CAMERA,
  nearestCluster3D,
  projectClusterPoint,
  zoomClusterCamera,
  type ClusterCamera,
} from "./cluster-camera";

type Gesture =
  | {
      kind: "rotate" | "pan";
      pointer: number;
      start: number[];
      camera: ClusterCamera;
    }
  | {
      kind: "cut";
      pointer: number;
      points: number[][];
      view: FeatureProjection;
      key: string;
      session: string;
      revision: number;
      tool: string;
    };

const EMPTY_AXES: number[][] = [];
const AXIS_COLOURS = ["#b24944", "#398354", "#456cb4"];

function CubeAxes({ view, mode }: { view: FeatureProjection; mode: string }) {
  const corners = Array.from({ length: 8 }, (_, i) => {
    const [x, y, z] = projectClusterPoint(view.matrix, i & 1, (i >> 1) & 1, (i >> 2) & 1);
    return { x: x * view.width, y: (1 - y) * view.height, z };
  });
  return (
    <svg className="cluster-3d-axes" width={view.width} height={view.height} aria-hidden="true">
      {corners.flatMap((from, i) =>
        [0, 1, 2].flatMap((axis) => {
          if (i & (1 << axis)) {
            return [];
          }
          const to = corners[i | (1 << axis)];
          return [
            <line
              key={`${i}-${axis}`}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={i === 0 ? AXIS_COLOURS[axis] : "#d5d8dc"}
              strokeWidth={i === 0 ? 1.3 : 0.8}
            />,
          ];
        }),
      )}
      {[0, 1, 2].map((axis) => {
        const p = corners[1 << axis];
        const label = `${mode === "pca" ? "PC" : "A"}${axis + 1}`;
        if (p.x < 0 || p.x > view.width || p.y < 0 || p.y > view.height) {
          return null;
        }
        return (
          <text
            key={axis}
            x={Math.max(4, Math.min(view.width - 24, p.x + 4))}
            y={Math.max(12, Math.min(view.height - 4, p.y - 4))}
            fill={AXIS_COLOURS[axis]}
            fontSize="10"
            fontFamily="Arial"
            data-axis={label}
          >
            {label}
          </text>
        );
      })}
    </svg>
  );
}

/** One orthographic view of axes 1–3; all cuts pass through its full depth. */
export function Cluster3D({
  data,
  coordinates,
  settings,
  selected,
  range,
  tool,
  onTool,
  onPolygon,
  onPick,
}: {
  data: ViewData;
  coordinates: FeatureCoordinates;
  settings: Settings;
  selected: number;
  range: number[];
  tool: string;
  onTool: (tool: string) => void;
  onPolygon: (polygon: number[], ax: number, ay: number, projection?: FeatureProjection) => void;
  onPick: (group: number, source: boolean, toggle: boolean) => void;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const gpu = useRef<ClusterGPU | null>(null);
  const pointer = useRef<number[] | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const [stroke, setStroke] = useState<number[][]>([]);
  const [camera, setCamera] = useState(DEFAULT_CLUSTER_CAMERA);
  const [size, setSize] = useState({ width: 260, height: 240 });
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  const view = useMemo(() => clusterProjection(camera, size.width, size.height), [camera, size]);
  const renderMode = settings.renderMode;

  useEffect(() => {
    const c = canvas.current!;
    const plot = wrapper.current!;
    const restore = () => setVersion((v) => v + 1);
    const lost = (event: Event) => {
      event.preventDefault();
      gpu.current = null;
    };
    c.addEventListener("webglcontextlost", lost);
    c.addEventListener("webglcontextrestored", restore);
    const observer = new ResizeObserver(() => {
      setSize({
        width: Math.max(1, plot.clientWidth),
        height: Math.max(1, plot.clientHeight),
      });
    });
    observer.observe(plot);
    return () => {
      observer.disconnect();
      gpu.current?.dispose();
      c.removeEventListener("webglcontextlost", lost);
      c.removeEventListener("webglcontextrestored", restore);
    };
  }, []);

  useEffect(() => {
    try {
      if (canvas.current!.getContext("webgl2")?.isContextLost()) {
        return;
      }
      gpu.current ??= new ClusterGPU(canvas.current!);
      gpu.current.draw(data, coordinates, { renderMode }, selected, range, EMPTY_AXES, 1, view);
    } catch (e) {
      setError(String(e));
    }
  }, [data, coordinates, renderMode, selected, range, view, version]);

  useEffect(() => {
    const root = wrapper.current!;
    const zoom = (event: WheelEvent) => {
      event.preventDefault();
      if (gesture.current) {
        return;
      }
      const box = root.getBoundingClientRect();
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.height : 1);
      const factor = Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.0015);
      setCamera((current) =>
        zoomClusterCamera(
          current,
          factor,
          (event.clientX - box.left) / view.width,
          1 - (event.clientY - box.top) / view.height,
        ),
      );
    };
    root.addEventListener("wheel", zoom, { passive: false });
    return () => root.removeEventListener("wheel", zoom);
  }, [view.width, view.height]);

  useEffect(() => {
    const pick = (event: KeyboardEvent) => {
      const typing = (event.target as HTMLElement).matches(
        "input,select,textarea,[contenteditable=true]",
      );
      if (typing || event.ctrlKey || event.metaKey || event.altKey || event.repeat) {
        return;
      }
      if (event.key === "Escape" && gesture.current?.kind === "cut") {
        event.preventDefault();
        event.stopImmediatePropagation();
        gesture.current = null;
        setStroke([]);
        onTool("orbit");
        return;
      }
      const key = event.key.toLowerCase();
      const p = pointer.current;
      if (!p || gesture.current || tool === "disabled" || !["e", "f"].includes(key)) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const group = nearestCluster3D(
        coordinates.values,
        data.labels,
        data.times,
        view,
        p[0],
        p[1],
        selected,
        range,
      );
      if (group !== null) {
        onPick(group, key === "f", event.shiftKey);
      }
    };
    window.addEventListener("keydown", pick, true);
    return () => window.removeEventListener("keydown", pick, true);
  }, [data, coordinates, view, selected, range, tool, onPick, onTool]);

  const point = (event: React.PointerEvent) => {
    const box = event.currentTarget.getBoundingClientRect();
    return [
      Math.max(0, Math.min(view.width, event.clientX - box.left)),
      Math.max(0, Math.min(view.height, event.clientY - box.top)),
    ];
  };
  const start = (event: React.PointerEvent) => {
    if (tool === "disabled" || gesture.current || !event.isPrimary) {
      return;
    }
    const p = point(event);
    pointer.current = p;
    const pan = event.button === 1 || (event.button === 0 && event.shiftKey);
    if (pan || event.button === 2 || (event.button === 0 && tool === "orbit")) {
      gesture.current = {
        kind: pan ? "pan" : "rotate",
        start: p,
        camera,
        pointer: event.pointerId,
      };
    } else if (event.button === 0 && ["brush", "lasso"].includes(tool)) {
      gesture.current = {
        kind: "cut",
        points: [p],
        view,
        key: coordinates.key,
        session: data.session,
        revision: data.revision,
        tool,
        pointer: event.pointerId,
      };
      setStroke([p]);
    } else {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: React.PointerEvent) => {
    const p = point(event);
    pointer.current = p;
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) {
      return;
    }
    if (g.kind === "cut") {
      g.points.push(p);
      setStroke([...g.points]);
    } else {
      const dx = p[0] - g.start[0];
      const dy = p[1] - g.start[1];
      setCamera(
        g.kind === "pan"
          ? {
              ...g.camera,
              panX: g.camera.panX + dx / view.width,
              panY: g.camera.panY - dy / view.height,
            }
          : {
              ...g.camera,
              yaw: g.camera.yaw + dx * 0.01,
              pitch: Math.max(
                -Math.PI / 2 + 0.02,
                Math.min(Math.PI / 2 - 0.02, g.camera.pitch + dy * 0.01),
              ),
            },
      );
    }
  };
  const finish = (event: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) {
      return;
    }
    gesture.current = null;
    setStroke([]);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (
      g.kind !== "cut" ||
      g.key !== coordinates.key ||
      g.session !== data.session ||
      g.revision !== data.revision ||
      g.tool !== tool ||
      g.view !== view ||
      (tool === "lasso" && g.points.length < 3)
    ) {
      return;
    }
    onPolygon(
      g.points.flatMap(([x, y]) => [x / view.width, 1 - y / view.height]),
      0,
      1,
      g.view,
    );
  };
  const cancel = () => {
    gesture.current = null;
    setStroke([]);
  };

  return (
    <div className="cluster-3d-container">
      <div
        className={`clusters cluster-3d tool-${tool}`}
        ref={wrapper}
        role="region"
        aria-label="3D spike clusters"
        tabIndex={0}
        data-dimension="3"
        data-features={coordinates.mode}
        data-colour-mode={renderMode}
        data-feature-key={coordinates.key}
        data-projection={view.matrix.join(",")}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onPointerLeave={() => {
          pointer.current = null;
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <canvas ref={canvas} aria-label="Three-dimensional spike feature projection" />
        <CubeAxes view={view} mode={coordinates.mode} />
        <button
          className="cluster-3d-reset"
          type="button"
          aria-label="Reset 3D view"
          title="Reset rotation, pan and zoom"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setCamera(DEFAULT_CLUSTER_CAMERA)}
        >
          <RotateCcw size={14} />
        </button>
        {stroke.length > 0 && (
          <svg className="lasso-overlay">
            <polyline
              points={stroke.map((p) => p.join(",")).join(" ")}
              fill={tool === "brush" ? "none" : "rgba(103,217,188,.12)"}
              fillRule="evenodd"
              stroke="#8ce6cc"
              strokeWidth={tool === "brush" ? 18 : 1.5}
              strokeOpacity={tool === "brush" ? 0.3 : 1}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
        {error && <div className="plot-error">{error}</div>}
      </div>
      <div className="cluster-3d-hint">
        {tool === "orbit"
          ? "Drag to rotate · Shift-drag to pan · Scroll to zoom"
          : "Shift-drag to pan · Right-drag to rotate · Esc to navigate"}
        <span>
          {tool === "brush" || tool === "lasso"
            ? "Cuts include all depths."
            : "Choose brush or lasso to cut through all depths."}
        </span>
      </div>
    </div>
  );
}
