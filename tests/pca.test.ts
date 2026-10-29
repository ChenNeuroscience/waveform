import { expect, it } from "vitest";
import { corePromise } from "./wasm";
import { pcaRecording } from "./pca-fixture";
import { readRecording } from "../src/worker/recording";
import { fitPca } from "../src/worker/pca";
import { copyF32 } from "../src/worker/wasm";

it("plans sparse reads without 32-bit arithmetic overflow on large recordings", async () => {
  const w = await corePromise;
  const n = 10_000_000;
  const e = w.engine_new_cut(n);
  try {
    w.engine_pca_begin(e, 20000);
    const ranges = new Uint32Array(
      w.memory.buffer,
      w.engine_pca_ranges(e),
      w.engine_pca_ranges_len(e),
    );
    let end = 0;
    let count = 0;
    for (let i = 0; i < ranges.length; i += 2) {
      expect(ranges[i]).toBeGreaterThanOrEqual(end);
      end = ranges[i] + ranges[i + 1];
      expect(end).toBeLessThanOrEqual(n);
      count += ranges[i + 1];
    }
    expect(count).toBe(20000);
  } finally {
    w.engine_free(e);
  }
});

it("fits a bounded sample through Wasm and projects every spike into four independent PCs", async () => {
  const w = await corePromise;
  const fixture = pcaRecording(1024);
  const file = new File([fixture.header, fixture.raw], "pca.1");
  const a = await readRecording(w, file);
  try {
    await fitPca(
      w,
      a,
      64,
      () => {},
      () => {},
    );
    const values = copyF32(w, w.engine_pca_values(a.e), w.engine_pca_values_len(a.e));
    expect(values).toHaveLength(1024 * 4);
    for (let pc = 0; pc < 4; pc++) {
      const axis = values.filter((_, i) => i % 4 === pc);
      expect(Math.min(...axis)).toBeCloseTo(0);
      expect(Math.max(...axis)).toBeCloseTo(1);
      expect(axis.reduce((a, b) => a + b, 0) / 1024).toBeCloseTo(0.5);
    }
    expect([...new Uint16Array(w.memory.buffer, w.engine_labels(a.e), a.n)]).toEqual(
      Array(1024).fill(0),
    );
    expect(w.engine_pca_ranges_len(a.e)).toBe(0);
  } finally {
    w.engine_free(a.e);
  }
});

it("cancelling sampling clears partial PCA state while preserving labels and amplitudes", async () => {
  const w = await corePromise;
  const fixture = pcaRecording(512);
  const a = await readRecording(w, new File([fixture.header, fixture.raw], "pca.1"));
  let cancelled = false;
  const check = () => {
    if (cancelled) throw new Error("cancelled");
  };
  try {
    const amplitudes = new Uint8Array(w.memory.buffer, w.engine_amps(a.e), a.n * 4).slice();
    await expect(
      fitPca(w, a, 64, check, () => {
        cancelled = true;
      }),
    ).rejects.toThrow("cancelled");
    expect(w.engine_pca_values_len(a.e)).toBe(0);
    expect(w.engine_pca_ranges_len(a.e)).toBe(0);
    expect(new Uint8Array(w.memory.buffer, w.engine_amps(a.e), a.n * 4)).toEqual(amplitudes);
    await fitPca(
      w,
      a,
      64,
      () => {},
      () => {},
    );
    expect(w.engine_pca_values_len(a.e)).toBe(512 * 4);
  } finally {
    w.engine_free(a.e);
  }
});
