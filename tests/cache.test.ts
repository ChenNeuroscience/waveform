import { describe, expect, it } from "vitest";
import {
  CACHE_NUMBERS,
  cachedAnalysis,
  cachedTrajectory,
  setCacheInputs,
  type CacheInputs,
} from "../src/worker/position";
import { defaultSettings } from "../src/types";
import { corePromise, seedEngine } from "./wasm";

/** A 50 Hz .pos whose first LED moves one pixel right each sample. */
function pos(samples = 4) {
  const header = `pos_format t,x1,y1,x2,y2,numpix1,numpix2\nnum_pos_samples ${samples}\npixels_per_metre 100\nsample_rate 50 hz\nwindow_min_x 0\nwindow_max_x 40\nwindow_min_y 0\nwindow_max_y 40\r\ndata_start`;
  const raw = new Uint8Array(samples * 20);
  const view = new DataView(raw.buffer);
  for (let i = 0; i < samples; i++) {
    view.setUint16(i * 20 + 4, 20 + i);
    view.setUint16(i * 20 + 6, 20);
    view.setUint16(i * 20 + 8, 1023);
    view.setUint16(i * 20 + 10, 1023);
    view.setUint16(i * 20 + 12, 12);
  }
  return new File([header, raw], "trial.pos");
}

describe("the worker's Rust cache", () => {
  it("reads its numeric inputs in the order this side writes them", async () => {
    const w = await corePromise;
    const names = Array.from({ length: w.cache_input_count() }, (_, i) =>
      new TextDecoder().decode(
        new Uint8Array(w.memory.buffer, w.cache_input_name(i), w.cache_input_name_len(i)),
      ),
    );
    expect(names).toEqual([...CACHE_NUMBERS]);
  });

  it("keys analyses on everything beneath them, except what they ignore", async () => {
    const w = await corePromise;
    const e = seedEngine(w, [0, 20, 40, 60], [1, 1, 1, 1]);
    const inputs: CacheInputs = {
      pos: pos(),
      posFile: "cache-test|trial.pos",
      settings: { ...defaultSettings, posSmooth: 0, maxSpeed: 0 },
      recording: "cache-test|t1",
      // Named by cut, so lookups without the engine (which membership hashes need) can hit.
      cellPrefix: "cut|0",
    };
    const at = async (i: CacheInputs, engine = 0) => {
      await setCacheInputs(w, i);
      return cachedAnalysis(w, engine, 1, 1000, 1);
    };
    try {
      // Only computed once there is an engine; then found without one.
      expect(await at(inputs)).toBeUndefined();
      const first = (await at(inputs, e))!;
      expect(first.count).toBe(4);
      expect((await at(inputs))!.key).toBe(first.key);
      const path = cachedTrajectory(w)!;

      // The colour settings are only for drawing, so they don't change the key.
      const coloured = { ...inputs, settings: { ...inputs.settings, maxRate: 9, rateMapSteps: 3 } };
      expect((await at(coloured))!.key).toBe(first.key);

      // The sync offset moves spikes along the path, not the path or its dwell.
      const synced = { ...inputs, sync: -20 };
      expect(await at(synced)).toBeUndefined();
      const moved = (await at(synced, e))!;
      expect(moved.key).not.toBe(first.key);
      expect(moved.speedDwellKey).toBe(first.speedDwellKey);
      expect(cachedTrajectory(w)!.key).toBe(path.key);
      expect([...moved.spikes]).not.toEqual([...first.spikes]);
      // An edit of 0 is no edit.
      expect((await at({ ...inputs, sync: 0 }))!.key).toBe(first.key);

      // Another trial's identical file is a different position.
      expect(await at({ ...inputs, posFile: "other|trial.pos" })).toBeUndefined();
      // Bins change the analysis, but it is made from the cached spike samples, so it needs
      // no engine; a bin of the speed histogram changes its dwell too.
      const binned = (await at({ ...inputs, settings: { ...inputs.settings, binCm: 2 } }))!;
      expect(binned.key).not.toBe(first.key);
      expect(binned.speedDwellKey).toBe(first.speedDwellKey);
      const speed = (await at({ ...inputs, settings: { ...inputs.settings, speedBin: 2 } }, e))!;
      expect(speed.speedDwellKey).not.toBe(first.speedDwellKey);
    } finally {
      w.engine_free(e);
    }
  });

  it("finds a recording's analyses by cut and revision without its spikes", async () => {
    const w = await corePromise;
    const e = seedEngine(w, [0, 20], [2, 2]);
    const inputs: CacheInputs = {
      settings: defaultSettings,
      recording: "cache-test|t2",
      cellPrefix: "cut-a|0",
    };
    try {
      await setCacheInputs(w, inputs);
      expect(cachedAnalysis(w, 0, 2, 1000, 1)).toBeUndefined();
      const computed = cachedAnalysis(w, e, 2, 1000, 1)!;
      expect(cachedAnalysis(w, 0, 2, 1000, 1)!.key).toBe(computed.key);
      await setCacheInputs(w, { ...inputs, cellPrefix: "cut-a|1" });
      expect(cachedAnalysis(w, 0, 2, 1000, 1)).toBeUndefined();
    } finally {
      w.engine_free(e);
    }
  });
});
