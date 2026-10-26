import { readFile, open } from "node:fs/promises";
import { performance } from "node:perf_hooks";
const module = await WebAssembly.compile(
  await readFile("public/wasm/waveform_core.wasm"),
);
const w = (await WebAssembly.instantiate(module, {})).exports;
const file = process.argv[2];
let n = 9_000_000,
  offset = 0,
  handle;
if (file) {
  handle = await open(file);
  const b = Buffer.alloc(65536);
  await handle.read(b, 0, b.length, 0);
  const text = b.toString("latin1"),
    m = /num_spikes\s+(\d+)/.exec(text);
  n = +m[1];
  offset = text.indexOf("data_start") + 10;
}
const start = performance.now(),
  e = w.engine_new(n),
  chunk = 32768,
  bytes = Buffer.alloc(chunk * 216),
  ptr = w.alloc_bytes(bytes.length);
if (!file)
  for (let i = 0; i < chunk; i++)
    for (let c = 0; c < 4; c++)
      for (let t = 0; t < 50; t++)
        bytes[i * 216 + c * 54 + 4 + t] = Math.round(80 * Math.sin(t / 8 + c));
for (let first = 0; first < n; first += chunk) {
  const count = Math.min(chunk, n - first),
    len = count * 216;
  if (handle) {
    const { bytesRead } = await handle.read(
      bytes,
      0,
      len,
      offset + first * 216,
    );
    if (bytesRead !== len) throw new Error("Short read");
  } else
    for (let i = 0; i < count; i++)
      for (let c = 0; c < 4; c++)
        bytes.writeUInt32BE((first + i) * 16, i * 216 + c * 54);
  new Uint8Array(w.memory.buffer, ptr, len).set(bytes.subarray(0, len));
  w.engine_push(e, ptr, len);
}
w.free_bytes(ptr, bytes.length);
const decodeMs = performance.now() - start;
const labels = new Uint16Array(w.memory.buffer, w.engine_labels(e), n);
for (let i = 0; i < n; i++) labels[i] = i % 101;
w.engine_recount(e);
const edit = performance.now();
const changed = w.engine_relabel(e, 100, 1, 0),
  editMs = performance.now() - edit;
const counts = new Uint32Array(w.memory.buffer, w.engine_counts(e), 1024);
if (counts.reduce((a, b) => a + b, 0) !== n || counts[100] !== 0)
  throw new Error("Population mismatch");
const timestamps = new Uint32Array(w.memory.buffer, w.engine_times(e), n),
  amps = new Uint8Array(w.memory.buffer, w.engine_amps(e), n * 4);
console.log(
  JSON.stringify(
    {
      source: file || "synthetic chunk-fed 9M",
      spikes: n,
      bytesDecoded: n * 216,
      decodeMs: Math.round(decodeMs),
      mergeMs: +editMs.toFixed(2),
      changed,
      wasmMemoryMiB: +(w.memory.buffer.byteLength / 1048576).toFixed(2),
      firstTimestamp: timestamps[0],
      lastTimestamp: timestamps[n - 1],
      firstAmplitudes: Array.from(amps.subarray(0, 4)),
    },
    null,
    2,
  ),
);
if (handle) await handle.close();
w.engine_free(e);
