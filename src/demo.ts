import { fileId } from "./types";
import { copyU8, type Core } from "./wasm";
const encode = new TextEncoder(),
  tail = encode.encode("\r\ndata_end"),
  CHUNK = 32768;
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
        controller.enqueue(
          new Uint8Array(await this.slice(offset, end).arrayBuffer()),
        );
        offset = end;
      },
    });
  }
  override slice(start = 0, end = this.size, contentType = ""): Blob {
    start = Math.max(
      0,
      Math.min(this.size, start < 0 ? this.size + start : start),
    );
    end = Math.max(start, Math.min(this.size, end < 0 ? this.size + end : end));
    const { header, spikes, context } = this.spec,
      rawEnd = header.length + spikes * 216;
    const parts: BlobPart[] = [];
    if (start < header.length)
      parts.push(header.slice(start, Math.min(end, header.length)));
    const rawStart = Math.max(start, header.length),
      rawStop = Math.min(end, rawEnd);
    if (rawStop > rawStart) {
      const first = Math.floor((rawStart - header.length) / 216),
        count = Math.ceil((rawStop - header.length) / 216) - first,
        bytes = count * 216,
        p = this.wasm.alloc_bytes(bytes);
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
    if (end > rawEnd)
      parts.push(tail.slice(Math.max(0, start - rawEnd), end - rawEnd));
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
  options: { quick?: boolean; seed: number },
  progress: (fraction: number, message: string) => void,
): Promise<File[]> {
  const files: File[] = [],
    modified = Date.now(),
    cells = options.quick ? 12 : 100,
    duration = options.quick ? 600 : 1500,
    sizes = options.quick
      ? [
          [36000, 36000, 36000],
          [18000, 18000, 18000],
        ]
      : [
          [1800000, 900000, 450000],
          [9000000, 1200000, 600000],
        ],
    total = sizes.flat().reduce((a, b) => a + b, 0);
  let completed = 0;
  for (let trial = 0; trial < 2; trial++) {
    const name = `demo_${trial ? "linear-track" : "open-field"}`;
    files.push(
      new File(
        [
          `duration ${duration}\ntrial_date SIMULATED\ntrial_time ${trial ? "13" : "12"}:00:00\nexperimenter Simulated data\nsynthetic_seed ${options.seed}\n`,
        ],
        `${name}.set`,
        { lastModified: modified },
      ),
    );
    for (let tet = 1; tet <= 3; tet++) {
      const spikes = sizes[trial][tet - 1],
        context = w.synthetic_new(
          (options.seed + trial * 173) >>> 0,
          cells,
          spikes,
          duration,
          trial,
          tet,
        ),
        header = encode.encode(
          `duration ${duration}\nnum_spikes ${spikes}\nnum_chans 4\nsamples_per_spike 50\nbytes_per_sample 1\nbytes_per_timestamp 4\ntimebase 96000 hz\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start`,
        ),
        file = new File([header], `${name}.${tet}`, { lastModified: modified });
      if (!context)
        throw new Error("Invalid simulated recording configuration.");
      sources.set(fileId(file), { context, spikes, header, file });
      files.push(file);
      if (tet === 1) {
        const length = duration * 50 * 20,
          p = w.alloc_bytes(length);
        try {
          w.synthetic_position(context, p);
          files.push(
            new File(
              [
                `duration ${duration}\nnum_pos_samples ${duration * 50}\nsample_rate 50 hz\ntimestamp_timebase 96000 hz\npixels_per_metre 300\nwindow_min_x 0\nwindow_min_y 0\nwindow_max_x 300\nwindow_max_y ${trial ? 60 : 300}\npos_format t,x1,y1,x2,y2,numpix1,numpix2\r\ndata_start`,
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
      const parts: BlobPart[] = [
          `n_clusters: ${cells + 1}\nn_channels: 4\nExact_cut_for: ${name} spikes: ${spikes}\n`,
        ],
        p = w.alloc_bytes(CHUNK * 4);
      try {
        for (let first = 0; first < spikes; first += CHUNK) {
          const count = Math.min(CHUNK, spikes - first);
          w.synthetic_cut(context, first, count, p);
          parts.push(copyU8(w, p, count * 4));
          completed += count;
          if (first % (CHUNK * 16) === 0) {
            progress(
              completed / total,
              `Preparing simulated recordings ${Math.round((completed / total) * 100)}%`,
            );
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      } finally {
        w.free_bytes(p, CHUNK * 4);
      }
      files.push(
        new File(parts, `${name}_${tet}.cut`, { lastModified: modified }),
      );
    }
  }
  return files;
}
