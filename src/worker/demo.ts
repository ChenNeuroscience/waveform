import { fileId } from "../types";
import { copyU8, type Core } from "./wasm";
const CHUNK = 216 * 32768;
interface SourceSpec {
  dataset: number;
  index: number;
  size: number;
  file: File;
}
const sources = new Map<string, SourceSpec>();

/** Bytes start..end of file `index` in a Wasm synthetic dataset. */
function read(w: Core, dataset: number, index: number, start: number, end: number) {
  const n = end - start;
  if (n <= 0) {
    return new Uint8Array(0);
  }
  const p = w.alloc_bytes(n);
  try {
    w.synthetic_dataset_read(dataset, index, start, n, p);
    return copyU8(w, p, n);
  } finally {
    w.free_bytes(p, n);
  }
}

/** A browser-side File marker (just the header) is resolved to this random-access
 * source in the worker; raw tetrode bytes are synthesised only when read. */
export class SyntheticRecording extends File {
  constructor(
    readonly wasm: Core,
    readonly spec: SourceSpec,
  ) {
    super([spec.file], spec.file.name, { lastModified: spec.file.lastModified });
  }
  override get size() {
    return this.spec.size;
  }
  override arrayBuffer(): Promise<ArrayBuffer> {
    return this.slice().arrayBuffer();
  }
  override text(): Promise<string> {
    return this.slice().text();
  }
  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    let offset = 0;
    return new ReadableStream({
      pull: async (controller) => {
        if (offset >= this.size) {
          controller.close();
          return;
        }
        const end = Math.min(this.size, offset + CHUNK);
        controller.enqueue(new Uint8Array(await this.slice(offset, end).arrayBuffer()));
        offset = end;
      },
    });
  }
  override slice(start = 0, end = this.size, contentType = ""): Blob {
    start = Math.max(0, Math.min(this.size, start < 0 ? this.size + start : start));
    end = Math.max(start, Math.min(this.size, end < 0 ? this.size + end : end));
    const { dataset, index } = this.spec;
    return new Blob([read(this.wasm, dataset, index, start, end)], { type: contentType });
  }
}
export function recordingSource(wasm: Core, file: File): File {
  const spec = sources.get(fileId(file));
  return spec ? new SyntheticRecording(wasm, spec) : file;
}

/** The app's simulated datasets, as parameters for the Rust generator
 * (core/src/synthetic.rs, also runnable as the `synthetic` CLI). */
function preset(options: { quick?: boolean; stress?: "1m" | "9m" }) {
  const { quick, stress } = options;
  const trials = 5;
  const tetrodes = 8;
  // Requested spikes per recording, trial-major.
  const spikes = Array.from({ length: trials * tetrodes }, (_, i) => {
    const trial = Math.floor(i / tetrodes);
    const tet = i % tetrodes;
    if (quick) {
      return trial === 0 ? 18000 : 36000;
    }
    if (stress) {
      return trial === 0 && tet === 0 ? (stress === "9m" ? 9_000_000 : 1_000_000) : 50000;
    }
    return tet === 0 ? 50000 : 40000 + ((trial * 317 + tet * 2711) % 20001);
  });
  return {
    name: "demo_box",
    trials,
    tetrodes,
    duration: quick ? 600 : 1200,
    cells: quick ? [12] : stress ? [100] : [24, 36, 48],
    spikes,
  };
}

/** Copy `bytes` into Wasm memory for the duration of `f`. */
function withBytes<T>(w: Core, bytes: Uint8Array, f: (p: number) => T): T {
  const p = w.alloc_bytes(bytes.length);
  try {
    new Uint8Array(w.memory.buffer, p, bytes.length).set(bytes);
    return f(p);
  } finally {
    w.free_bytes(p, bytes.length);
  }
}

/** Generate the simulated dataset: small files in full, recordings as markers. */
export async function demoFiles(
  w: Core,
  options: { quick?: boolean; stress?: "1m" | "9m"; seed: number },
  progress: (fraction: number, message: string) => void,
): Promise<File[]> {
  const p = preset(options);
  const u32 = (values: number[]) => new Uint8Array(new Uint32Array(values).buffer);
  const name = new TextEncoder().encode(p.name);
  const cells = u32(p.cells);
  const spikes = u32(p.spikes);
  const dataset = withBytes(w, name, (n) =>
    withBytes(w, cells, (c) =>
      withBytes(w, spikes, (s) =>
        w.synthetic_dataset_new(
          options.seed,
          n,
          name.length,
          p.trials,
          p.tetrodes,
          p.duration,
          c,
          p.cells.length,
          s,
          p.spikes.length,
        ),
      ),
    ),
  );
  if (!dataset) {
    throw new Error("Invalid simulated recording configuration.");
  }
  const decode = new TextDecoder();
  const entries = Array.from({ length: w.synthetic_dataset_files(dataset) }, (_, index) => ({
    index,
    name: decode.decode(
      copyU8(
        w,
        w.synthetic_dataset_name(dataset, index),
        w.synthetic_dataset_name_len(dataset, index),
      ),
    ),
    // Sizes reach ~2 GB, so read the usize as unsigned.
    size: w.synthetic_dataset_size(dataset, index) >>> 0,
    recording: w.synthetic_dataset_is_recording(dataset, index) !== 0,
  }));
  const total = entries.reduce((a, e) => a + (e.recording ? 0 : e.size), 0);
  const modified = Date.now();
  const files: File[] = [];
  let completed = 0;
  for (const { index, name, size, recording } of entries) {
    if (recording) {
      const header = read(w, dataset, index, 0, w.synthetic_dataset_header_len(dataset, index));
      const file = new File([header], name, { lastModified: modified });
      sources.set(fileId(file), { dataset, index, size, file });
      files.push(file);
      continue;
    }
    const parts: BlobPart[] = [];
    for (let start = 0; start < size; start += CHUNK) {
      const end = Math.min(size, start + CHUNK);
      parts.push(read(w, dataset, index, start, end));
      completed += end - start;
      progress(
        Math.min(1, completed / total),
        `Preparing simulated recordings ${Math.min(100, Math.round((completed / total) * 100))}%`,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    files.push(new File(parts, name, { lastModified: modified }));
  }
  return files;
}
