import { it, expect } from "vitest";
import { corePromise, decodeCut } from "./wasm";
import { demoFiles, recordingSource } from "../src/demo";
import { parseHeader } from "../src/files";
it("generated files share an acquisition clock and support exact random-access byte ranges", async () => {
  const w = await corePromise;
  const files = await demoFiles(w, { quick: true, seed: 4271 }, () => {});
  const marker = files.find((f) => f.name === "demo_linear-track.1")!,
    source = recordingSource(w, marker),
    prefix = new Uint8Array(await source.slice(0, 65536).arrayBuffer()),
    { header, offset } = parseHeader(prefix);
  expect(header.num_spikes).toBe("18000");
  expect(source.size).toBe(offset + 18000 * 216 + 10);
  expect(marker.size).toBeLessThan(1024); // No multi-GB fake waveform Blob is retained.
  const a = new Uint8Array(
    await source.slice(offset + 43, offset + 216 * 7 + 17).arrayBuffer(),
  );
  const b = new Uint8Array(
    await source.slice(offset, offset + 216 * 9).arrayBuffer(),
  );
  expect(a).toEqual(b.subarray(43, 216 * 7 + 17));
  expect(await source.slice(-10).text()).toBe("\r\ndata_end");
  const cut = files.find((f) => f.name === "demo_linear-track_1.cut")!;
  const labels = await decodeCut(cut, 18000);
  expect(Math.max(...labels)).toBe(12);
  const p = w.alloc_bytes(216 * 9),
    engine = w.engine_new(9);
  try {
    new Uint8Array(w.memory.buffer, p, b.length).set(b);
    w.engine_push(engine, p, b.length);
    const times = [
      ...new Uint32Array(w.memory.buffer, w.engine_times(engine), 9),
    ];
    expect(times[0]).toBe(0);
    expect(times[8]).toBe(Math.floor((8 * 600 * 96000) / 18000));
  } finally {
    w.engine_free(engine);
    w.free_bytes(p, 216 * 9);
  }
});
