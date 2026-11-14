import { expect, it } from "vitest";
import { corePromise, seedRecording } from "./wasm";
import { pcaRecording } from "./pca-fixture";
import { fitPca } from "../src/worker/pca";
import { ask } from "../src/worker/compute";
import { defaultSettings } from "../src/types";

const settings = { ...defaultSettings, pcaSamples: 64 };

it("plans sparse reads without 32-bit arithmetic overflow on large recordings", async () => {
  const w = await corePromise;
  const n = 10_000_000;
  const pca = w.pca_new(n, 20000);
  try {
    const at = w.pca_ranges(pca);
    const ranges = new Uint32Array(w.memory.buffer, at, w.pca_ranges_len(pca));
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
    w.pca_free(pca);
  }
});

it("fits a bounded sample through Wasm and projects every spike into four independent PCs", async () => {
  const w = await corePromise;
  const fixture = pcaRecording(1024);
  const recording = await seedRecording([], Array(1024).fill(0), {
    raw: fixture.raw,
    header: fixture.header,
  });
  const values = (await ask(w, { settings, recording }, "pca")).buffers.values as Float32Array;
  expect(values).toHaveLength(1024 * 4);
  for (let pc = 0; pc < 4; pc++) {
    const axis = values.filter((_, i) => i % 4 === pc);
    expect(Math.min(...axis)).toBeCloseTo(0);
    expect(Math.max(...axis)).toBeCloseTo(1);
    expect(axis.reduce((a, b) => a + b, 0) / 1024).toBeCloseTo(0.5);
  }
  // Labels never influence the basis, and are untouched by it.
  expect([...(await ask(w, { settings, recording }, "view")).buffers.labels]).toEqual(
    Array(1024).fill(0),
  );
});

it("a cancelled fit leaves nothing behind, and a later fit succeeds", async () => {
  const w = await corePromise;
  const fixture = pcaRecording(512);
  const recording = await seedRecording([], Array(512).fill(0), {
    raw: fixture.raw,
    header: fixture.header,
  });
  const amplitudes = (await ask(w, { settings, recording }, "population")).buffers.features;
  let cancelled = false;
  const check = () => {
    if (cancelled) throw new Error("cancelled");
  };
  await expect(
    fitPca(w, recording, 64, check, () => {
      cancelled = true;
    }),
  ).rejects.toThrow("cancelled");
  expect((await ask(w, { settings, recording }, "population")).buffers.features).toEqual(
    amplitudes,
  );
  const values = (await ask(w, { settings, recording }, "pca")).buffers.values;
  expect(values).toHaveLength(512 * 4);
});
