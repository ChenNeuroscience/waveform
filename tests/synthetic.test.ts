import { it, expect } from "vitest";
import { corePromise, decodeCut } from "./wasm";
import { demoFiles, recordingSource } from "../src/demo";
import { parseHeader } from "../src/files";
it("generated files share an acquisition clock and support exact random-access byte ranges", async () => {
  const w = await corePromise;
  const files = await demoFiles(w, { quick: true, seed: 4271 }, () => {});
  const marker = files.find((f) => f.name === "demo_box-a.1")!,
    source = recordingSource(w, marker),
    prefix = new Uint8Array(await source.slice(0, 65536).arrayBuffer()),
    { header, offset } = parseHeader(prefix);
  // Poisson spiking: the count varies around the requested 18,000.
  const n = Number(header.num_spikes);
  expect(Math.abs(n - 18000)).toBeLessThan(800);
  expect(source.size).toBe(offset + n * 216 + 10);
  expect(marker.size).toBeLessThan(1024); // No multi-GB fake waveform Blob is retained.
  const a = new Uint8Array(await source.slice(offset + 43, offset + 216 * 7 + 17).arrayBuffer());
  const b = new Uint8Array(await source.slice(offset, offset + 216 * 9).arrayBuffer());
  expect(a).toEqual(b.subarray(43, 216 * 7 + 17));
  expect(await source.slice(-10).text()).toBe("\r\ndata_end");
  const cut = files.find((f) => f.name === "demo_box-a_1.cut")!;
  const labels = await decodeCut(cut, n);
  expect(Math.max(...labels)).toBe(12);
  // Tetrode 8 is uncut; tetrode 7 has only two cells sorted.
  expect(files.some((f) => f.name === "demo_box-a_8.cut")).toBe(false);
  const partial = files.find((f) => f.name === "demo_box-a_7.cut")!,
    n7 = Number(
      parseHeader(
        new Uint8Array(
          await recordingSource(
            w,
            files.find((f) => f.name === "demo_box-a.7")!,
          )
            .slice(0, 65536)
            .arrayBuffer(),
        ),
      ).header.num_spikes,
    );
  expect(new Set(await decodeCut(partial, n7))).toEqual(new Set([0, 1, 2]));
  const p = w.alloc_bytes(216 * 9),
    engine = w.engine_new(9);
  try {
    new Uint8Array(w.memory.buffer, p, b.length).set(b);
    w.engine_push(engine, p, b.length);
    const times = [...new Uint32Array(w.memory.buffer, w.engine_times(engine), 9)];
    // Poisson spike times on the 96 kHz clock, starting in the first seconds.
    expect(times).toEqual([...times].sort((x, y) => x - y));
    expect(times[8]).toBeLessThan(96000 * 5);
  } finally {
    w.engine_free(engine);
    w.free_bytes(p, 216 * 9);
  }
});
