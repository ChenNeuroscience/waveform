import { describe, expect, it } from "vitest";
import {
  HANDLERS,
  COMPUTE_INPUTS,
  analysis,
  command,
  trajectory,
  type ComputeInputs,
} from "../src/worker/compute";
import { defaultSettings, reuseParts, type AnalysisPart } from "../src/types";
import { corePromise, seedRecording } from "./wasm";

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

describe("the worker's compute graph", () => {
  it("lists its inputs and handlers in the order this side uses them", async () => {
    const w = await corePromise;
    expect(
      await names(w.compute_input_count(), w.compute_input_name, w.compute_input_name_len),
    ).toEqual([...COMPUTE_INPUTS]);
    expect(
      await names(w.compute_handler_count(), w.compute_handler_name, w.compute_handler_name_len),
    ).toEqual([...HANDLERS]);
  });

  it("keys each part on everything beneath it, except what its handler ignores", async () => {
    const w = await corePromise;
    const inputs: ComputeInputs = {
      pos: pos(),
      posFile: "compute-test|trial.pos",
      settings: { ...defaultSettings, posSmooth: 0, maxSpeed: 0 },
      recording: await seedRecording([0, 20, 40, 60], [1, 1, 1, 1], { duration: 1 }),
    };
    const parts: AnalysisPart[] = ["stats", "spatial", "speed", "speedDwell", "spikes"];
    const at = (i: ComputeInputs) => analysis(w, i, 1, parts);
    const first = await at(inputs);
    expect(first.count).toBe(4);
    expect((await at(inputs)).keys).toEqual(first.keys);
    const path = (await trajectory(w, inputs))!;

    // The colour settings are only for drawing, so they change no key.
    const coloured = { ...inputs, settings: { ...inputs.settings, maxRate: 9, rateMapSteps: 3 } };
    expect((await at(coloured)).keys).toEqual(first.keys);

    // The sync offset moves spikes along the path: not the path, its dwell or the stats.
    const synced = { ...inputs, sync: -20 };
    const moved = await at(synced);
    expect(moved.keys.spatial).not.toBe(first.keys.spatial);
    expect(moved.keys.spikes).not.toBe(first.keys.spikes);
    expect(moved.keys.speedDwell).toBe(first.keys.speedDwell);
    expect(moved.keys.stats).toBe(first.keys.stats);
    expect((await trajectory(w, synced))!.key).toBe(path.key);
    expect([...moved.spikes]).not.toEqual([...first.spikes]);
    // An edit of 0 is no edit.
    expect((await at({ ...inputs, sync: 0 })).keys).toEqual(first.keys);

    // A new bin width changes only the rate map.
    const binned = await at({ ...inputs, settings: { ...inputs.settings, binCm: 2 } });
    expect(binned.keys.spatial).not.toBe(first.keys.spatial);
    expect({ ...binned.keys, spatial: "" }).toEqual({ ...first.keys, spatial: "" });
    // Another trial's identical file is a different position, though its stats aren't.
    const other = await at({ ...inputs, posFile: "other|trial.pos" });
    expect(other.keys.spatial).not.toBe(first.keys.spatial);
    expect(other.keys.stats).toBe(first.keys.stats);

    // Held parts with unchanged keys keep their arrays, so their plots needn't redraw.
    const kept = reuseParts(first, binned);
    expect(kept.speed).toBe(first.speed);
    expect(kept.spatial).toBe(binned.spatial);
    expect(reuseParts(first, await at(inputs))).toBe(first);
  });

  it("keys a cell's analyses by its spikes, so edits elsewhere leave them", async () => {
    const w = await corePromise;
    const recording = await seedRecording([0, 20, 40, 60], [1, 1, 2, 3], { duration: 1 });
    const inputs: ComputeInputs = { settings: defaultSettings, recording };
    const keys = async (history: string[], cell: number) =>
      (
        await analysis(w, { ...inputs, recording: { ...recording, history } }, cell, [
          "stats",
          "ac",
        ])
      ).keys;
    const [one, two] = [await keys([], 1), await keys([], 2)];
    await command(w, { ...inputs, patch: "merge" }, () => w.command_relabel(3, 2, 0));
    expect(await keys(["merge"], 1)).toEqual(one);
    expect(await keys(["merge"], 2)).not.toEqual(two);
    // Swapping two cells' numbers keeps each set of spikes' analyses.
    await command(w, { ...inputs, patch: "swap" }, () => w.command_relabel(1, 2, 1));
    expect(await keys(["swap"], 2)).toEqual(one);
  });
});
