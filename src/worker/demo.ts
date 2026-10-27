import { fileId } from "../types";
import { copyU8, type Core } from "./wasm";
const encode = new TextEncoder();
const tail = encode.encode("\r\ndata_end");
const CHUNK = 32768;
interface SourceSpec {
  context: number;
  spikes: number;
  header: Uint8Array;
  file: File;
}
const sources = new Map<string, SourceSpec>();

/** A browser-side File marker is resolved to this random-access source in the worker. */
export class SyntheticRecording extends File {
  constructor(
    readonly wasm: Core,
    readonly spec: SourceSpec,
  ) {
    super([spec.header.slice()], spec.file.name, {
      lastModified: spec.file.lastModified,
    });
  }
  override get size() {
    return this.spec.header.length + this.spec.spikes * 216 + tail.length;
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
        const end = Math.min(this.size, offset + CHUNK * 216);
        controller.enqueue(new Uint8Array(await this.slice(offset, end).arrayBuffer()));
        offset = end;
      },
    });
  }
  override slice(start = 0, end = this.size, contentType = ""): Blob {
    start = Math.max(0, Math.min(this.size, start < 0 ? this.size + start : start));
    end = Math.max(start, Math.min(this.size, end < 0 ? this.size + end : end));
    const { header, spikes, context } = this.spec;
    const rawEnd = header.length + spikes * 216;
    const parts: BlobPart[] = [];
    if (start < header.length) {
      parts.push(header.slice(start, Math.min(end, header.length)));
    }
    const rawStart = Math.max(start, header.length);
    const rawStop = Math.min(end, rawEnd);
    if (rawStop > rawStart) {
      const first = Math.floor((rawStart - header.length) / 216);
      const count = Math.ceil((rawStop - header.length) / 216) - first;
      const bytes = count * 216;
      const p = this.wasm.alloc_bytes(bytes);
      try {
        this.wasm.synthetic_records(context, first, count, p);
        parts.push(
          copyU8(this.wasm, p, bytes).subarray(
            rawStart - header.length - first * 216,
            rawStop - header.length - first * 216,
          ),
        );
      } finally {
        this.wasm.free_bytes(p, bytes);
      }
    }
    if (end > rawEnd) {
      parts.push(tail.slice(Math.max(0, start - rawEnd), end - rawEnd));
    }
    return new Blob(parts, { type: contentType });
  }
}
export function recordingSource(wasm: Core, file: File): File {
  const spec = sources.get(fileId(file));
  return spec ? new SyntheticRecording(wasm, spec) : file;
}
/** Generate cuts/position files; raw tetrode bytes are synthesised only when read. */
export async function demoFiles(
  w: Core,
  options: { quick?: boolean; stress?: boolean; seed: number },
  progress: (fraction: number, message: string) => void,
): Promise<File[]> {
  const files: File[] = [];
  const modified = Date.now();
  const duration = options.quick ? 600 : 1200;
  const sizes = Array.from({ length: 5 }, (_, trial) =>
    Array.from({ length: 8 }, (_, tet) =>
      options.quick
        ? trial === 0
          ? 18000
          : 36000
        : options.stress
          ? trial === 0 && tet === 0
            ? 9000000
            : 50000
          : tet === 0
            ? 50000
            : 40000 + ((trial * 317 + tet * 2711) % 20001),
    ),
  );
  const total = sizes.flat().reduce((a, b) => a + b, 0);
  let completed = 0;
  for (let trial = 0; trial < 5; trial++) {
    const name = `demo_box-${String.fromCharCode(97 + trial)}`;
    files.push(
      new File(
        [
          `duration ${duration}\ntrial_date SIMULATED\ntrial_time ${trial ? "13" : "12"}:00:00\nexperimenter Simulated data\nsynthetic_seed ${options.seed}\n`,
        ],
        `${name}.set`,
        { lastModified: modified },
      ),
    );
    for (let tet = 1; tet <= 8; tet++) {
      const cells = options.quick ? 12 : options.stress ? 100 : [24, 36, 48][(tet - 1) % 3];
      const context = w.synthetic_new(
        (options.seed + trial * 173) >>> 0,
        cells,
        sizes[trial][tet - 1],
        duration,
        tet,
      );
      // Poisson spiking: the count is near the requested size, not exact.
      const spikes = context ? w.synthetic_spikes(context) : 0;
      const header = encode.encode(
        `duration ${duration}\nnum_spikes ${spikes}\nnum_chans 4\nsamples_per_spike 50\nbytes_per_sample 1\nbytes_per_timestamp 4\ntimebase 96000 hz\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start`,
      );
      const file = new File([header], `${name}.${tet}`, { lastModified: modified });
      if (!context) {
        throw new Error("Invalid simulated recording configuration.");
      }
      sources.set(fileId(file), { context, spikes, header, file });
      files.push(file);
      if (tet === 1) {
        const length = duration * 50 * 20;
        const p = w.alloc_bytes(length);
        try {
          w.synthetic_position(context, p);
          files.push(
            new File(
              [
                `duration ${duration}\nnum_pos_samples ${duration * 50}\nsample_rate 50 hz\ntimestamp_timebase 96000 hz\npixels_per_metre 300\nwindow_min_x 0\nwindow_min_y 0\nwindow_max_x 300\nwindow_max_y 300\npos_format t,x1,y1,x2,y2,numpix1,numpix2\r\ndata_start`,
                copyU8(w, p, length),
                tail,
              ],
              `${name}.pos`,
              { lastModified: modified },
            ),
          );
        } finally {
          w.free_bytes(p, length);
        }
      }
      // Like data you come to yourself: tetrode 8 is uncut, tetrode 7 has only
      // two cells sorted with everything else left in noise group 0.
      if (tet === 8) {
        completed += spikes;
        continue;
      }
      const keep = tet === 7 ? 2 : 0;
      const parts: BlobPart[] = [
        `n_clusters: ${(keep || cells) + 1}\nn_channels: 4\nExact_cut_for: ${name} spikes: ${spikes}\n`,
      ];
      const p = w.alloc_bytes(CHUNK * 4);
      try {
        for (let first = 0; first < spikes; first += CHUNK) {
          const count = Math.min(CHUNK, spikes - first);
          w.synthetic_cut(context, first, count, p, keep);
          parts.push(copyU8(w, p, count * 4));
          completed += count;
          if (first % (CHUNK * 16) === 0) {
            progress(
              Math.min(1, completed / total),
              `Preparing simulated recordings ${Math.min(100, Math.round((completed / total) * 100))}%`,
            );
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      } finally {
        w.free_bytes(p, CHUNK * 4);
      }
      files.push(new File(parts, `${name}_${tet}.cut`, { lastModified: modified }));
    }
  }
  return files;
}
