import { expect, it, vi } from "vitest";
import { readRecording } from "../src/worker/recording";
import { corePromise } from "./wasm";
import { Superseded } from "../src/worker/protocol";

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

it("streams the same validated timestamps and cut labels used by active and clipboard analyses", async () => {
  const w = await corePromise;
  const cut = new File(["Exact_cut_for: trial spikes: 3\n1 2 1\n"], "trial_1.cut");
  const a = await readRecording(w, recording(3), cut);
  try {
    expect([...new Uint32Array(w.memory.buffer, w.engine_times(a.e), 3)]).toEqual([
      96000, 192000, 288000,
    ]);
    expect([...new Uint16Array(w.memory.buffer, w.engine_labels(a.e), 3)]).toEqual([1, 2, 1]);
    expect([...new Uint32Array(w.memory.buffer, w.engine_counts(a.e), 3)]).toEqual([0, 2, 1]);
    expect(a.n).toBe(3);
    expect(a.header.timebase).toBe("96000 hz");
  } finally {
    w.engine_free(a.e);
  }
});

it("frees a cancelled temporary recording while preserving another live engine", async () => {
  const w = await corePromise;
  const primary = await readRecording(w, recording(1));
  const free = vi.fn(w.engine_free);
  let read = 0;
  try {
    await expect(
      readRecording({ ...w, engine_free: free }, recording(32769), undefined, {
        current: () => read === 0,
        progress: () => {
          read++;
        },
      }),
    ).rejects.toBeInstanceOf(Superseded);
    expect(free).toHaveBeenCalledTimes(1);
    expect(free.mock.calls[0][0]).not.toBe(primary.e);
    expect(new Uint32Array(w.memory.buffer, w.engine_times(primary.e), 1)[0]).toBe(96000);
  } finally {
    w.engine_free(primary.e);
  }
});

it("rejects truncated recordings before allocating a population", async () => {
  const w = await corePromise;
  const create = vi.fn(w.engine_new);
  await expect(readRecording({ ...w, engine_new: create }, recording(3, 1))).rejects.toThrow(
    "Invalid/truncated tetrode",
  );
  expect(create).not.toHaveBeenCalled();
});
