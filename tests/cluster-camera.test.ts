import { expect, it } from "vitest";
import {
  clusterProjection,
  DEFAULT_CLUSTER_CAMERA,
  nearestCluster3D,
  projectClusterPoint,
  zoomClusterCamera,
} from "../src/plots/cluster-camera";
import { corePromise } from "./wasm";
import { pcaRecording } from "./pca-fixture";
import { readRecording } from "../src/worker/recording";
import { fitPca } from "../src/worker/pca";
import { copyF32, copyU16, withF32, withU16 } from "../src/worker/wasm";

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

it("rotated PCA lasso cuts use the first three PCs through all depths and support exact undo", async () => {
  const w = await corePromise;
  const fixture = pcaRecording();
  const a = await readRecording(w, new File([fixture.header, fixture.raw], "pca.1"));
  try {
    new Uint16Array(w.memory.buffer, w.engine_labels(a.e), a.n).set(fixture.labels);
    w.engine_recount(a.e);
    await fitPca(
      w,
      a,
      64,
      () => {},
      () => {},
    );
    const values = copyF32(w, w.engine_pca_values(a.e), w.engine_pca_values_len(a.e));
    // View PC3 horizontally and PC2 vertically; PC1 supplies depth.
    const matrix = [0, 0, 1, 0, 0, 1, 0, 0];
    const polygon = [0.5, -0.05, 1.05, -0.05, 1.05, 1.05, 0.5, 1.05];
    const expected = fixture.labels.map((label, i) =>
      label === 1 && values[i * 4 + 2] > 0.5 ? 3 : label,
    );
    w.engine_edit_begin(a.e);
    withU16(w, [1], (sources, n) =>
      withF32(w, matrix, (m) =>
        withF32(w, polygon, (p, count) =>
          w.engine_projected_region(a.e, sources, n, 3, 5, m, p, count, 0, 300, 200),
        ),
      ),
    );
    expect(w.engine_edit_finish(a.e)).toBeGreaterThan(0);
    expect(copyU16(w, w.engine_labels(a.e), a.n)).toEqual(new Uint16Array(expected));
    w.engine_patch_apply(a.e, w.engine_patch(a.e), w.engine_patch_len(a.e), 0);
    expect(copyU16(w, w.engine_labels(a.e), a.n)).toEqual(new Uint16Array(fixture.labels));
  } finally {
    w.engine_free(a.e);
  }
});
