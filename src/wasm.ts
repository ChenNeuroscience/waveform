/** Host bindings only. Population loops belong to core/src, never this module. */
export type Core = { memory: WebAssembly.Memory; [name: string]: any };
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
export function withU16<T>(
  w: Core,
  values: number[],
  f: (p: number, n: number) => T,
): T {
  const a = new Uint16Array(values),
    p = w.alloc_bytes(a.byteLength);
  try {
    new Uint16Array(w.memory.buffer, p, a.length).set(a);
    return f(p, a.length);
  } finally {
    w.free_bytes(p, a.byteLength);
  }
}
export function withF32<T>(
  w: Core,
  values: number[],
  f: (p: number, n: number) => T,
): T {
  const a = new Float32Array(values),
    p = w.alloc_bytes(a.byteLength);
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
      const n = Math.min(chunk, length - first),
        bytes = new Uint8Array(
          await file.slice(offset + first, offset + first + n).arrayBuffer(),
        );
      if (bytes.length !== n) throw new Error("Truncated file read.");
      new Uint8Array(w.memory.buffer, p, n).set(bytes);
      consume(p, n, first);
      progress?.((first + n) / Math.max(1, length));
    }
  } finally {
    w.free_bytes(p, chunk);
  }
}
