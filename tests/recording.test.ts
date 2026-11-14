import { expect, it, vi } from "vitest";
import { readHeader, readPopulation } from "../src/worker/recording";
import { ask, type RecordingSource } from "../src/worker/compute";
import { corePromise } from "./wasm";
import { Superseded } from "../src/worker/protocol";
import { defaultSettings } from "../src/types";

function recording(spikes: number, records = spikes) {
  const raw = new Uint8Array(records * 216);
  const view = new DataView(raw.buffer);
  for (let i = 0; i < records; i++) view.setUint32(i * 216, (i + 1) * 96000);
  return new File(
    [
      `num_spikes ${spikes}\nnum_chans 4\nsamples_per_spike 50\ntimebase 96000 hz\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start`,
      raw,
    ],
    "trial.1",
  );
}

it("reads the same validated timestamps and cut labels used by active and clipboard analyses", async () => {
  const w = await corePromise;
  const file = recording(3);
  const cut = new File(["Exact_cut_for: trial spikes: 3\n1 2 1\n"], "trial_1.cut");
  const header = await readHeader(file);
  expect(header.n).toBe(3);
  expect(header.header.timebase).toBe("96000 hz");
  const source: RecordingSource = {
    key: "recording-test",
    file,
    ...header,
    cut,
    cutSource: "recording-test.cut",
    history: [],
  };
  const i = { settings: defaultSettings, recording: source };
  expect([...(await ask(w, i, "population")).buffers.times]).toEqual([96000, 192000, 288000]);
  const { labels, counts } = (await ask(w, i, "view")).buffers;
  expect([...labels]).toEqual([1, 2, 1]);
  expect([...counts.subarray(0, 3)]).toEqual([0, 2, 1]);
});

it("frees a cancelled population read", async () => {
  const w = await corePromise;
  const file = recording(32769);
  const free = vi.fn(w.population_free);
  let read = 0;
  await expect(
    readPopulation({ ...w, population_free: free }, file, await readHeader(file), {
      current: () => read === 0,
      progress: () => {
        read++;
      },
    }),
  ).rejects.toBeInstanceOf(Superseded);
  expect(free).toHaveBeenCalledTimes(1);
});

it("rejects truncated recordings before allocating a population", async () => {
  await expect(readHeader(recording(3, 1))).rejects.toThrow("Invalid/truncated tetrode");
});
