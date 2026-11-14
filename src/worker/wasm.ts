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
  cache_handler_count: 0,
  cache_handler_name: 1,
  cache_handler_name_len: 1,
  cache_input_count: 0,
  cache_input_name: 1,
  cache_input_name_len: 1,
  cache_numbers: 0,
  cache_put_raw: 1,
  cache_request: 5,
  cache_set_text: 3,
  engine_amps: 1,
  engine_brush: 8,
  engine_build_wave_order: 1,
  engine_cell_hashes: 1,
  engine_counts: 1,
  engine_cut_abort: 1,
  engine_cut_begin: 2,
  engine_cut_feed: 3,
  engine_cut_finish: 1,
  engine_edit_begin: 1,
  engine_edit_finish: 1,
  engine_edit_rollback: 1,
  engine_export_chunk: 4,
  engine_free: 1,
  engine_gate_begin: 3,
  engine_gate_feed: 4,
  engine_labels: 1,
  engine_new: 1,
  engine_new_cut: 1,
  engine_output: 1,
  engine_output_len: 1,
  engine_patch: 1,
  engine_patch_apply: 4,
  engine_patch_clear: 1,
  engine_patch_len: 1,
  engine_pca_begin: 2,
  engine_pca_clear: 1,
  engine_pca_finish: 1,
  engine_pca_fit: 1,
  engine_pca_project: 3,
  engine_pca_ranges: 1,
  engine_pca_ranges_len: 1,
  engine_pca_sample: 3,
  engine_pca_values: 1,
  engine_pca_values_len: 1,
  engine_polygon: 8,
  engine_projected_region: 12,
  engine_push: 3,
  engine_recount: 1,
  engine_relabel: 4,
  engine_resident_bytes: 1,
  engine_split_cache_begin: 2,
  engine_split_cache_finish: 1,
  engine_split_cached: 1,
  engine_split_gate: 5,
  engine_times: 1,
  engine_unsorted: 1,
  engine_wave_batch: 1,
  engine_wave_batch_len: 1,
  engine_wave_begin: 3,
  engine_wave_feed: 4,
  engine_wave_hashes: 1,
  engine_wave_hashes_len: 1,
  engine_wave_order: 1,
  engine_wave_order_len: 1,
  engine_wave_record: 2,
  engine_wave_slots: 1,
  engine_wave_starts: 1,
  engine_wave_starts_len: 1,
  free_bytes: 2,
  position_bearing: 2,
  position_free: 1,
  position_new: 7,
  position_push: 3,
  position_set_ppm: 3,
  position_used_extent: 1,
  synthetic_dataset_files: 1,
  synthetic_dataset_free: 1,
  synthetic_dataset_header_len: 2,
  synthetic_dataset_is_recording: 2,
  synthetic_dataset_name: 2,
  synthetic_dataset_name_len: 2,
  synthetic_dataset_new: 10,
  synthetic_dataset_read: 5,
  synthetic_dataset_size: 2,
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
