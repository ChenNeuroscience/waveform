import { readFile } from "node:fs/promises";
import { readCut } from "../src/files";
import type { Core } from "../src/wasm";
export const corePromise = readFile(
  new URL("../public/wasm/waveform_core.wasm", import.meta.url),
).then(
  async (bytes) =>
    (await WebAssembly.instantiate(await WebAssembly.compile(bytes), {}))
      .exports as Core,
);
export async function decodeCut(file: File, n: number) {
  const w = await corePromise,
    e = w.engine_new(n);
  try {
    await readCut(file, n, w, e);
    return new Uint16Array(w.memory.buffer, w.engine_labels(e), n).slice();
  } finally {
    w.engine_free(e);
  }
}
export function seedEngine(w: Core, timestamps: number[], labels: number[]) {
  const e = w.engine_new(labels.length),
    raw = new Uint8Array(labels.length * 216),
    d = new DataView(raw.buffer);
  timestamps.forEach((t, i) => {
    for (let c = 0; c < 4; c++) d.setUint32(i * 216 + c * 54, t);
  });
  const p = w.alloc_bytes(raw.length);
  new Uint8Array(w.memory.buffer, p, raw.length).set(raw);
  w.engine_push(e, p, raw.length);
  w.free_bytes(p, raw.length);
  new Uint16Array(w.memory.buffer, w.engine_labels(e), labels.length).set(
    labels,
  );
  w.engine_recount(e);
  return e;
}
