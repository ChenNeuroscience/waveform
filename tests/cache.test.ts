import { describe, expect, it } from "vitest";
import {
  CACHE_HANDLERS,
  CACHE_NUMBERS,
  analysis,
  trajectory,
  type CacheInputs,
} from "../src/worker/position";
import { defaultSettings, reuseParts, type AnalysisPart } from "../src/types";
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
async function names(count: number, name: (i: number) => number, len: (i: number) => number) {
  const w = await corePromise;
  return Array.from({ length: count }, (_, i) => {
    const [at, n] = [name(i), len(i)];
    return new TextDecoder().decode(new Uint8Array(w.memory.buffer, at, n));
  });
}

describe("the worker's Rust cache", () => {
  it("lists its inputs and handlers in the order this side uses them", async () => {
    const w = await corePromise;
    expect(await names(w.cache_input_count(), w.cache_input_name, w.cache_input_name_len)).toEqual([
      ...CACHE_NUMBERS,
    ]);
    expect(
      await names(w.cache_handler_count(), w.cache_handler_name, w.cache_handler_name_len),
    ).toEqual([...CACHE_HANDLERS]);
  });

  it("keys each part on everything beneath it, except what its handler ignores", async () => {
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
    const parts: AnalysisPart[] = ["stats", "spatial", "speed", "speedDwell", "spikes"];
    const at = (i: CacheInputs, engine = 0) =>
      analysis(w, i, { engine, cell: 1, tb: 1000, duration: 1 }, parts);
    try {
      // Only computed once there is an engine; then found without one.
      expect(await at(inputs)).toBeUndefined();
      const first = (await at(inputs, e))!;
      expect(first.count).toBe(4);
      expect((await at(inputs))!.keys).toEqual(first.keys);
      const path = (await trajectory(w, inputs))!;

      // The colour settings are only for drawing, so they change no key.
      const coloured = { ...inputs, settings: { ...inputs.settings, maxRate: 9, rateMapSteps: 3 } };
      expect((await at(coloured))!.keys).toEqual(first.keys);

      // The sync offset moves spikes along the path: not the path, its dwell or the stats.
      const synced = { ...inputs, sync: -20 };
      expect(await at(synced)).toBeUndefined();
      const moved = (await at(synced, e))!;
      expect(moved.keys.spatial).not.toBe(first.keys.spatial);
      expect(moved.keys.spikes).not.toBe(first.keys.spikes);
      expect(moved.keys.speedDwell).toBe(first.keys.speedDwell);
      expect(moved.keys.stats).toBe(first.keys.stats);
      expect((await trajectory(w, synced))!.key).toBe(path.key);
      expect([...moved.spikes]).not.toEqual([...first.spikes]);
      // An edit of 0 is no edit.
      expect((await at({ ...inputs, sync: 0 }))!.keys).toEqual(first.keys);

      // A new bin width is made from the cached spike samples, so needs no engine; only
      // the rate map changes.
      const binned = (await at({ ...inputs, settings: { ...inputs.settings, binCm: 2 } }))!;
      expect(binned.keys.spatial).not.toBe(first.keys.spatial);
      expect({ ...binned.keys, spatial: "" }).toEqual({ ...first.keys, spatial: "" });
      // Another trial's identical file is a different position.
      const other = { ...inputs, posFile: "other|trial.pos" };
      expect(await at(other)).toBeUndefined();

      // Held parts with unchanged keys keep their arrays, so their plots needn't redraw.
      const kept = reuseParts(first, binned);
      expect(kept.speed).toBe(first.speed);
      expect(kept.spatial).toBe(binned.spatial);
      expect(reuseParts(first, (await at(inputs))!)).toBe(first);
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
    const cell = (engine: number) => ({ engine, cell: 2, tb: 1000, duration: 1 });
    try {
      expect(await analysis(w, inputs, cell(0), ["stats", "ac"])).toBeUndefined();
      const computed = (await analysis(w, inputs, cell(e), ["stats", "ac"]))!;
      expect((await analysis(w, inputs, cell(0), ["stats", "ac"]))!.keys).toEqual(computed.keys);
      const nextRevision = { ...inputs, cellPrefix: "cut-a|1" };
      expect(await analysis(w, nextRevision, cell(0), ["stats", "ac"])).toBeUndefined();
    } finally {
      w.engine_free(e);
    }
  });
});
