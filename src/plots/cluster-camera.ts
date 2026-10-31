import type { FeatureMode, FeatureProjection } from "../types";

export interface ClusterCamera {
  yaw: number;
  pitch: number;
  zoom: number;
  panX: number;
  panY: number;
}

export const DEFAULT_CLUSTER_CAMERA: ClusterCamera = {
  yaw: -0.6,
  pitch: 0.4,
  zoom: 1,
  panX: 0,
  panY: 0,
};

/** Keep all three axes at the same scale, even in a rectangular pane. */
export function clusterProjection(
  camera: ClusterCamera,
  width: number,
  height: number,
  omitted = 3,
): FeatureProjection {
  const cy = Math.cos(camera.yaw);
  const sy = Math.sin(camera.yaw);
  const cp = Math.cos(camera.pitch);
  const sp = Math.sin(camera.pitch);
  const scale = 0.6 * camera.zoom * Math.min(width, height);
  const row = (axis: number[], factor: number, pan = 0) => {
    const xyz = axis.map((value) => value * factor);
    return [...xyz, 0.5 + pan - xyz.reduce((sum, value) => sum + value, 0) / 2];
  };
  return {
    axes: [0, 1, 2, 3].filter((axis) => axis !== omitted),
    // Float32 rows make CPU, shader and Wasm projection agree at cut boundaries.
    matrix: [
      ...new Float32Array([
        ...row([cy, 0, sy], scale / width, camera.panX),
        ...row([sp * sy, cp, -sp * cy], scale / height, camera.panY),
        ...row([-cp * sy, sp, cp * cy], 0.5),
      ]),
    ],
    width,
    height,
  };
}

export function projectClusterPoint(matrix: number[], x: number, y: number, z: number) {
  return [0, 4, 8].map(
    (i) => matrix[i] * x + matrix[i + 1] * y + matrix[i + 2] * z + matrix[i + 3],
  );
}

/** Zoom around the pointer so a cluster under it stays in place. */
export function zoomClusterCamera(
  camera: ClusterCamera,
  factor: number,
  x: number,
  y: number,
): ClusterCamera {
  const zoom = Math.max(0.3, Math.min(12, camera.zoom * factor));
  const ratio = zoom / camera.zoom;
  return {
    ...camera,
    zoom,
    panX: x - 0.5 - (x - 0.5 - camera.panX) * ratio,
    panY: y - 0.5 - (y - 0.5 - camera.panY) * ratio,
  };
}

/** Picking only on E/F avoids a population scan on every pointer move. */
export function nearestCluster3D(
  values: Uint8Array | Float32Array,
  labels: Uint16Array,
  times: Uint32Array,
  view: FeatureProjection,
  px: number,
  py: number,
  selected: number,
  range: number[],
) {
  const scale = values instanceof Uint8Array ? 1 / 255 : 1;
  const timeScale = 1 / Math.max(1, times[times.length - 1] || 0);
  let group: number | null = null;
  let best = 25;
  let depth = Infinity;
  const m = view.matrix;
  for (let i = 0; i < labels.length; i++) {
    const time = times[i] * timeScale;
    if (time < range[0] || time > range[1]) {
      continue;
    }
    const x = values[i * 4 + view.axes[0]] * scale;
    const y = values[i * 4 + view.axes[1]] * scale;
    const z = values[i * 4 + view.axes[2]] * scale;
    const fx = m[0] * x + m[1] * y + m[2] * z + m[3];
    const fy = m[4] * x + m[5] * y + m[6] * z + m[7];
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) {
      continue;
    }
    const distance = (px - fx * view.width) ** 2 + (py - (1 - fy) * view.height) ** 2;
    const d = m[8] * x + m[9] * y + m[10] * z + m[11] - (labels[i] === selected ? 0.00001 : 0);
    if (distance < best || (distance === best && d < depth)) {
      best = distance;
      depth = d;
      group = labels[i];
    }
  }
  return group;
}

export interface SavedClusterProjection {
  camera: ClusterCamera;
  omitted: number;
  mode: FeatureMode;
  samples: number;
}

/** Short, versioned text for notes. Number.toString preserves every camera bit. */
export function encodeClusterProjection({
  camera,
  omitted,
  mode,
  samples,
}: SavedClusterProjection) {
  const prefix = mode === "pca" ? "PC" : "A";
  const axes = [0, 1, 2, 3]
    .filter((axis) => axis !== omitted)
    .map((axis) => `${prefix}${axis + 1}`)
    .join("-");
  return `waveform3d:v1:${axes}:${samples}:${[
    camera.yaw,
    camera.pitch,
    camera.zoom,
    camera.panX,
    camera.panY,
  ].join(",")}`;
}

export function decodeClusterProjection(text: string): SavedClusterProjection {
  // Allow a code copied out of a sentence or Markdown in the user's notes.
  const match = text.match(
    /waveform3d:v1:((?:A|PC)[1-4]-(?:A|PC)[1-4]-(?:A|PC)[1-4]):(\d+):([-+\d.eE,]+)/,
  );
  if (!match) {
    throw new Error("Paste a waveform3d:v1 projection code.");
  }
  const labels = match[1].split("-");
  const mode = labels[0].startsWith("PC") ? "pca" : "amplitudes";
  const prefix = mode === "pca" ? "PC" : "A";
  const axes = labels.map((label) => Number(label.replace(/^(A|PC)/, "")) - 1);
  const tokens = match[3].replace(/[.,]+$/, "").split(",");
  const values = tokens.map(Number);
  const samples = Number(match[2]);
  const [yaw, pitch, zoom, panX, panY] = values;
  if (
    values.length !== 5 ||
    tokens.some((token) => !token) ||
    !values.every(Number.isFinite) ||
    !labels.every((label) => label.startsWith(prefix)) ||
    !axes.every((axis, i) => i === 0 || axis > axes[i - 1]) ||
    Math.abs(pitch) > Math.PI / 2 ||
    zoom < 0.3 ||
    zoom > 12 ||
    !Number.isInteger(samples) ||
    samples < 4 ||
    samples > 20000
  ) {
    throw new Error("This projection code contains invalid view settings.");
  }
  return {
    camera: { yaw, pitch, zoom, panX, panY },
    omitted: [0, 1, 2, 3].find((axis) => !axes.includes(axis))!,
    mode,
    samples,
  };
}
