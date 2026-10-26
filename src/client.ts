import type { ViewData } from "./types";
import wasmUrl from "./generated/waveform_core.wasm?url";
const worker = new Worker(new URL("./engine.worker.ts", import.meta.url), {
  type: "module",
});
worker.postMessage({
  id: 0,
  type: "init",
  url: new URL(wasmUrl, document.baseURI).href,
});
let id = 0;
const pending = new Map<
  number,
  {
    resolve: (data: any) => void;
    reject: (e: Error) => void;
    progress?: (n: number, message: string) => void;
  }
>();
worker.onmessage = (e) => {
  const m = e.data,
    p = pending.get(m.id);
  if (!p) return;
  if (m.progress !== undefined) {
    p.progress?.(m.progress, m.message);
    return;
  }
  pending.delete(m.id);
  if (m.error) p.reject(new Error(m.error));
  else p.resolve(m.data);
};
worker.onerror = (e) => {
  for (const p of pending.values())
    p.reject(new Error(e.message || "Data worker failed."));
  pending.clear();
};
export function request<T = ViewData>(
  type: string,
  payload: Record<string, unknown> = {},
  progress?: (n: number, message: string) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject, progress });
    worker.postMessage({ id: n, type, ...payload });
  });
}
