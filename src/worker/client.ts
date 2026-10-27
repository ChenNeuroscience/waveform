import type { ViewData, ViewMessage } from "../types";
import { Superseded, type Payload, type RequestType, type Result } from "./protocol";
import wasmUrl from "../generated/waveform_core.wasm?url";
const worker = new Worker(new URL("./engine.worker.ts", import.meta.url), {
  type: "module",
});
worker.postMessage({
  id: 0,
  type: "init",
  url: new URL(wasmUrl, document.baseURI).href,
});
let id = 0;
// The latest recording's per-spike amplitudes and times, which the worker sends
// only when the recording changes.
let population: Pick<ViewData, "key" | "features" | "times"> | null = null;
function complete(data: any) {
  if (!data || typeof data !== "object" || !("labels" in data && "key" in data)) {
    return data;
  }
  const view = data as ViewMessage;
  if (view.features && view.times) {
    population = { key: view.key, features: view.features, times: view.times };
  } else if (population?.key === view.key) {
    Object.assign(view, {
      features: population.features,
      times: population.times,
    });
  }
  return view;
}
const pending = new Map<
  number,
  {
    resolve: (data: any) => void;
    reject: (e: Error) => void;
    progress?: (n: number, message: string) => void;
  }
>();
worker.onmessage = (e) => {
  const m = e.data;
  const p = pending.get(m.id);
  if (!p) {
    return;
  }
  if (m.progress !== undefined) {
    p.progress?.(m.progress, m.message);
    return;
  }
  pending.delete(m.id);
  if (m.error) {
    p.reject(m.superseded ? new Superseded(m.error) : new Error(m.error));
  } else {
    p.resolve(complete(m.data));
  }
};
worker.onerror = (e) => {
  for (const p of pending.values()) {
    p.reject(new Error(e.message || "Data worker failed."));
  }
  pending.clear();
};
export function request<K extends RequestType>(
  type: K,
  payload: Payload<K>,
  progress?: (n: number, message: string) => void,
): Promise<Result<K>> {
  return new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject, progress });
    worker.postMessage({ id: n, type, ...payload });
  });
}
