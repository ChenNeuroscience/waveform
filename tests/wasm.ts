import { readFile } from "node:fs/promises";
import type { Core } from "../src/worker/wasm";
import { ask, type RecordingSource } from "../src/worker/compute";
import { readHeader } from "../src/worker/recording";
import { defaultSettings } from "../src/types";
export const corePromise = readFile(
  new URL("../public/wasm/waveform_core.wasm", import.meta.url),
).then(
  async (bytes) =>
    (await WebAssembly.instantiate(await WebAssembly.compile(bytes), {})).exports as Core,
);
/** Each test recording's own identity: the compute graph keeps values for the session. */
let seeded = 0;
/** A cut file's labels, read through the compute graph as the app reads them. */
export async function decodeCut(file: File, n: number) {
  const w = await corePromise;
  const key = `decoded-${++seeded}`;
  const recording: RecordingSource = {
    key,
    file: new File([], key),
    header: { timebase: "1" },
    offset: 0,
    n,
    cut: file,
    cutSource: key,
    history: [],
  };
  return (await ask(w, { settings: defaultSettings, recording }, "view")).buffers
    .labels as Uint16Array;
}
/**
 * A recording as the compute graph takes it: an in-memory tetrode file with spikes at
 * `timestamps` (flat waveforms, unless `raw` gives the records) and a cut file of `labels`.
 */
export async function seedRecording(
  timestamps: number[],
  labels: number[],
  options: { timebase?: number; duration?: number; raw?: Uint8Array; header?: string } = {},
): Promise<RecordingSource> {
  const n = labels.length;
  const raw = options.raw ?? new Uint8Array(n * 216);
  if (!options.raw) {
    const d = new DataView(raw.buffer);
    timestamps.forEach((t, i) => {
      for (let c = 0; c < 4; c++) d.setUint32(i * 216 + c * 54, t);
    });
  }
  const header =
    options.header ??
    `num_spikes ${n}\nnum_chans 4\nsamples_per_spike 50\ntimebase ${options.timebase ?? 1000} hz\n${options.duration ? `duration ${options.duration}\n` : ""}spike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start`;
  const key = `seeded-${++seeded}`;
  const file = new File([header, raw as Uint8Array<ArrayBuffer>], `${key}.1`);
  const cut = new File([`Exact_cut_for: ${key} spikes: ${n}\n${labels.join(" ")}`], `${key}_1.cut`);
  return { key, file, ...(await readHeader(file)), cut, cutSource: `${key}.cut`, history: [] };
}
