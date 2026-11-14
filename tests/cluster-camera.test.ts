import { expect, it } from "vitest";
import {
  clusterProjection,
  DEFAULT_CLUSTER_CAMERA,
  nearestCluster3D,
  projectClusterPoint,
  zoomClusterCamera,
  encodeClusterProjection,
  decodeClusterProjection,
} from "../src/plots/cluster-camera";
import { corePromise, seedRecording } from "./wasm";
import { pcaRecording } from "./pca-fixture";
import { ask, command } from "../src/worker/compute";
import { withF32, withU16 } from "../src/worker/wasm";
import { defaultSettings } from "../src/types";

it("keeps a rectangular pane isotropic and zooms around the pointer", () => {
  const camera = { ...DEFAULT_CLUSTER_CAMERA, panX: 0.1, panY: -0.05 };
  const view = clusterProjection(camera, 640, 260);
  const m = view.matrix;
  expect(Math.hypot(...m.slice(0, 3)) * view.width).toBeCloseTo(
    Math.hypot(...m.slice(4, 7)) * view.height,
  );
  expect(projectClusterPoint(m, 0.5, 0.5, 0.5).slice(0, 2)).toEqual([
    expect.closeTo(0.6, 6),
    expect.closeTo(0.45, 6),
  ]);
  const point = [0.2, 0.7, 0.9];
  const before = projectClusterPoint(m, point[0], point[1], point[2]);
  const zoomed = zoomClusterCamera(camera, 2, before[0], before[1]);
  const after = projectClusterPoint(
    clusterProjection(zoomed, 640, 260).matrix,
    point[0],
    point[1],
    point[2],
  );
  expect(after[0]).toBeCloseTo(before[0], 6);
  expect(after[1]).toBeCloseTo(before[1], 6);
  expect(zoomClusterCamera(camera, 1000, 0.5, 0.5).zoom).toBe(12);
});

it("picks the front spike at an overlap, ignoring the fourth coordinate and clipped points", () => {
  const camera = { ...DEFAULT_CLUSTER_CAMERA, yaw: 0, pitch: 0 };
  const view = clusterProjection(camera, 200, 200);
  const values = new Float32Array([0.5, 0.5, 0.8, 0, 0.5, 0.5, 0.2, 1, 2, 0.5, 0, 0]);
  const labels = new Uint16Array([1, 2, 3]);
  const times = new Uint32Array([1, 2, 3]);
  expect(nearestCluster3D(values, labels, times, view, 100, 100, 1, [0, 1])).toBe(2);
  expect(nearestCluster3D(values, labels, times, view, 100, 100, 1, [0, 0.4])).toBe(1);
  expect(nearestCluster3D(values, labels, times, view, 190, 100, 1, [0, 1])).toBeNull();
});

it("rotated PCA lasso cuts use the selected PCs including PC4 and support exact undo", async () => {
  const w = await corePromise;
  const fixture = pcaRecording();
  const recording = await seedRecording([], fixture.labels, {
    raw: fixture.raw,
    header: fixture.header,
  });
  const settings = { ...defaultSettings, pcaSamples: 64 };
  const values = (await ask(w, { settings, recording }, "pca")).buffers.values as Float32Array;
  // Omit PC2: view PC4 horizontally and PC3 vertically, with PC1 as depth.
  const matrix = [0, 0, 1, 0, 0, 1, 0, 0];
  const polygon = [0.5, -0.05, 1.05, -0.05, 1.05, 1.05, 0.5, 1.05];
  const expected = fixture.labels.map((label, i) =>
    label === 1 && values[i * 4 + 3] > 0.5 ? 3 : label,
  );
  const { changed } = await command(w, { settings, recording, patch: "lasso" }, () =>
    withU16(w, [1], (sources, n) =>
      withU16(w, [0, 2, 3], (axes) =>
        withF32(w, matrix, (m) =>
          withF32(w, polygon, (p, count) =>
            w.command_region(sources, n, 3, 5, axes, m, p, count, 0, 300, 200),
          ),
        ),
      ),
    ),
  );
  expect(changed).toBeGreaterThan(0);
  const at = async (history: string[]) =>
    (await ask(w, { settings, recording: { ...recording, history } }, "view")).buffers.labels;
  expect(await at(["lasso"])).toEqual(new Uint16Array(expected));
  expect(await at([])).toEqual(new Uint16Array(fixture.labels));
});

it("projection codes name the displayed axes and restore every camera setting exactly", () => {
  const camera = {
    ...DEFAULT_CLUSTER_CAMERA,
    yaw: 1.234567890123456,
    zoom: 3.141592653589793,
    panX: -0.1234567890123456,
    panY: 1.25e-8,
  };
  for (const mode of ["amplitudes", "pca"] as const) {
    for (const omitted of [3, 2, 1, 0]) {
      const saved = { camera, mode, omitted };
      const code = encodeClusterProjection(saved);
      expect(code.split(":")).toHaveLength(4);
      const prefix = mode === "pca" ? "PC" : "A";
      const axes = [1, 2, 3, 4]
        .filter((axis) => axis !== omitted + 1)
        .map((axis) => `${prefix}${axis}`)
        .join("-");
      expect(code).toContain(axes);
      expect(decodeClusterProjection(`Saved view: \`${code}\`.`)).toEqual(saved);
      expect(decodeClusterProjection(code.replace(`${axes}:`, `${axes}:1500:`))).toEqual(saved);
      expect(clusterProjection(camera, 300, 200, omitted).axes).toEqual(
        [0, 1, 2, 3].filter((axis) => axis !== omitted),
      );
    }
  }
});

it("rejects malformed projection codes without accepting mixed or duplicate axes", () => {
  for (const code of [
    "no view",
    "waveform3d:v2:A1-A2-A3:5000:0,0,1,0,0",
    "waveform3d:v1:A1-PC2-A3:5000:0,0,1,0,0",
    "waveform3d:v1:A1-A1-A3:5000:0,0,1,0,0",
    "waveform3d:v1:A1-A2-A3:5000:0,0,100,0,0",
    "waveform3d:v1:A1-A2-A3:5000:0,,1,0,0",
  ]) {
    expect(() => decodeClusterProjection(code)).toThrow();
  }
});
