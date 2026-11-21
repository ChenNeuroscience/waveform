/** Host bindings only. Population loops belong to core/src, never this module. */

/** Every Wasm export and its argument count. The Core type is derived from this
 * table, and tests/wasm-exports.test.ts checks it against the compiled module, so
 * a renamed export or changed signature fails to compile or test. */
export const EXPORTS = {
  alloc_bytes: 1,
  answer_count: 0,
  answer_data: 1,
  answer_digest: 0,
  answer_kind: 1,
  answer_len: 1,
  answer_name: 1,
  answer_name_len: 1,
  command_brush: 7,
  command_changed: 0,
  command_export: 3,
  command_output: 0,
  command_output_len: 0,
  command_polygon: 7,
  command_region: 11,
  command_relabel: 3,
  command_split: 4,
  compute_bytes: 0,
  compute_handler_count: 0,
  compute_handler_name: 1,
  compute_handler_name_len: 1,
  compute_input_count: 0,
  compute_input_name: 1,
  compute_input_name_len: 1,
  compute_inputs: 0,
  compute_request: 2,
  compute_set_recording: 3,
  compute_set_text: 3,
  compute_supply_cut: 1,
  compute_supply_egf: 1,
  compute_supply_log: 2,
  compute_supply_patch: 2,
  compute_supply_pca: 1,
  compute_supply_population: 1,
  compute_supply_position: 1,
  compute_supply_scan: 1,
  cut_feed: 3,
  cut_finish: 1,
  cut_free: 1,
  cut_new: 2,
  egf_free: 1,
  egf_new: 2,
  egf_push: 3,
  free_bytes: 2,
  missing_patch: 0,
  missing_patch_len: 0,
  pca_finish: 1,
  pca_fit: 1,
  pca_free: 1,
  pca_new: 2,
  pca_project: 3,
  pca_ranges: 1,
  pca_ranges_len: 1,
  pca_sample: 3,
  population_free: 1,
  population_new: 1,
  population_push: 3,
  position_bearing: 2,
  position_free: 1,
  position_new: 7,
  position_push: 3,
  position_set_ppm: 3,
  position_used_extent: 1,
  scan_feed: 4,
  scan_free: 1,
  scan_take: 0,
  synthetic_dataset_files: 1,
  synthetic_dataset_free: 1,
  synthetic_dataset_header_len: 2,
  synthetic_dataset_is_lazy: 2,
  synthetic_dataset_name: 2,
  synthetic_dataset_name_len: 2,
  synthetic_dataset_new: 10,
  synthetic_dataset_read: 5,
  synthetic_dataset_size: 2,
  wave_batch_data: 1,
  wave_batch_feed: 4,
  wave_batch_free: 1,
  wave_batch_len: 1,
  wave_batch_new: 3,
  wave_record: 2,
  wave_slots: 1,
} as const;
type Args<N extends number, A extends number[] = []> = A["length"] extends N
  ? A
  : Args<N, [...A, number]>;
export type Core = { memory: WebAssembly.Memory } & {
  readonly [K in keyof typeof EXPORTS]: (...args: Args<(typeof EXPORTS)[K]>) => number;
};
export function copyU8(w: Core, p: number, n: number) {
  return new Uint8Array(w.memory.buffer, p, n).slice();
}
export function copyU16(w: Core, p: number, n: number) {
  return new Uint16Array(w.memory.buffer, p, n).slice();
}
export function copyU32(w: Core, p: number, n: number) {
  return new Uint32Array(w.memory.buffer, p, n).slice();
}
export function copyF32(w: Core, p: number, n: number) {
  return new Float32Array(w.memory.buffer, p, n).slice();
}
export function withU8<T>(w: Core, values: Uint8Array, f: (p: number, n: number) => T): T {
  const p = w.alloc_bytes(Math.max(1, values.length));
  try {
    new Uint8Array(w.memory.buffer, p, values.length).set(values);
    return f(p, values.length);
  } finally {
    w.free_bytes(p, Math.max(1, values.length));
  }
}
export function withU16<T>(w: Core, values: number[], f: (p: number, n: number) => T): T {
  const a = new Uint16Array(values);
  const p = w.alloc_bytes(a.byteLength);
  try {
    new Uint16Array(w.memory.buffer, p, a.length).set(a);
    return f(p, a.length);
  } finally {
    w.free_bytes(p, a.byteLength);
  }
}
export function withF32<T>(w: Core, values: number[], f: (p: number, n: number) => T): T {
  const a = new Float32Array(values);
  const p = w.alloc_bytes(a.byteLength);
  try {
    new Float32Array(w.memory.buffer, p, a.length).set(a);
    return f(p, a.length);
  } finally {
    w.free_bytes(p, a.byteLength);
  }
}
export async function streamFile(
  w: Core,
  file: File,
  offset: number,
  length: number,
  chunk: number,
  consume: (p: number, bytes: number, first: number) => void,
  progress?: (fraction: number) => void,
) {
  const p = w.alloc_bytes(chunk);
  try {
    for (let first = 0; first < length; first += chunk) {
      const n = Math.min(chunk, length - first);
      const bytes = new Uint8Array(
        await file.slice(offset + first, offset + first + n).arrayBuffer(),
      );
      if (bytes.length !== n) {
        throw new Error("Truncated file read.");
      }
      new Uint8Array(w.memory.buffer, p, n).set(bytes);
      consume(p, n, first);
      progress?.((first + n) / Math.max(1, length));
    }
  } finally {
    w.free_bytes(p, chunk);
  }
}
