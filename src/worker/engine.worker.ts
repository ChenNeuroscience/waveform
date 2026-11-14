/// <reference lib="webworker" />
// Owns browser handles and asynchronous scheduling. Everything computed (spikes, labels,
// waveform order, PCA, positions and analyses) comes from Rust's compute graph
// (core/src/compute.rs) through compute.ts, which reads the files it says it needs. What is
// kept here is which recordings and cuts exist and each cut's edit history, as patch ids.
import { demoFiles, recordingSource } from "./demo";
import { parseHeader, textHeader } from "../files";
import {
  defaultSettings,
  fileId,
  type AnalysisData,
  type AnalysisPart,
  type Header,
  type HistoryEntry,
  type ViewMessage,
} from "../types";
import {
  analysis,
  ask,
  command,
  exportLabels,
  positionHeader,
  trajectory,
  type ComputeInputs,
  type RecordingSource,
} from "./compute";
import { openStore, put } from "./history";
import { streamFile, copyU8, withU16, withF32, type Core } from "./wasm";
import { Superseded } from "./protocol";
import { readHeader, type RecordingHeader } from "./recording";
import type { RequestType, WorkerMessage, WorkerResult } from "./protocol";

/** A recording: its file (or synthetic stand-in) and header. Its spikes are read into the
 * compute graph when first needed. */
interface Recording extends RecordingHeader {
  key: string;
  file: File;
  /** From the header, or (once its spikes are read) its last spike. */
  duration: number;
}
/** A recording with a cut: where its labels start, and the edits made since. */
interface Session {
  key: string;
  asset: string;
  cut?: File;
  cutSource: string;
  /** Applied edits, oldest first; each `id` names its patch. */
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  /** A split being previewed: a patch shown but not yet applied. */
  preview?: { id: string; patch: Uint8Array; changed: number };
  dirty: boolean;
  revision: number;
  n: number;
  localCut?: { id: string; name: string };
}
const recordings = new Map<string, Recording>();
const sessions = new Map<string, Session>();
let wasmPromise: Promise<Core>;
let latestLoad = 0;
let latestCopy = 0;
let latestFeatures = 0;
let active: Session | undefined;
const dbPromise = openStore();
let latestAnalysisBatch = "";
let splitState: { source: number; channel: number; sample: number; threshold: number } | undefined;
let currentHeaders: Record<string, Header> = {};
// Amplitudes and timestamps never change for a recording, so they are sent only
// when the recording changes; client.ts reattaches them to later views.
let populationSent = "";
function progress(id: number, value: number, message: string) {
  self.postMessage({ id, progress: value, message });
}
async function recordingFor(w: Core, key: string, file: File): Promise<Recording> {
  let r = recordings.get(key);
  if (!r) {
    const source = recordingSource(w, file);
    const header = await readHeader(source);
    r = { key, file: source, ...header, duration: parseFloat(header.header.duration) || 0 };
    recordings.set(key, r);
  }
  return r;
}
/** A session as the compute graph takes it: its recording and history, with a previewed
 * split unless `preview` is false. */
function source(s: Session, preview = true): RecordingSource {
  const r = recordings.get(s.asset)!;
  return {
    ...r,
    cut: s.cut,
    cutSource: s.cutSource,
    history: [...s.undo.map((e) => e.id), ...(preview && s.preview ? [s.preview.id] : [])],
  };
}
function inputs(s: Session, extra: Partial<ComputeInputs> = {}): ComputeInputs {
  return { settings: defaultSettings, recording: source(s), ...extra };
}
function forkSession(s: Session, descriptor: any): Session {
  if (!descriptor || typeof descriptor.id !== "string" || typeof descriptor.name !== "string") {
    return s;
  }
  const key = `${s.asset}|${descriptor.id}`;
  if (sessions.has(key)) {
    throw new Error("Cut identity already exists.");
  }
  return {
    ...s,
    key,
    undo: [...s.undo],
    redo: [...s.redo],
    preview: undefined,
    localCut: { id: descriptor.id, name: descriptor.name },
  };
}
function acceptSession(s: Session) {
  sessions.set(s.key, s);
  active = s;
  if (s.localCut) {
    currentHeaders.cut = { file: s.localCut.name, source: "Modified cut" };
  }
}
/** Keeps an edit: its patch, then it in the session's history (forking a local cut first
 * if asked). Nothing changes if the patch can't be stored. */
async function record(
  s: Session,
  entry: HistoryEntry,
  patch: Uint8Array,
  newCut: unknown,
): Promise<Session> {
  try {
    await put(await dbPromise, `patch:${entry.id}`, patch);
  } catch (error) {
    throw new Error(`Edit rolled back: undo storage is unavailable (${String(error)}).`);
  }
  s.preview = undefined;
  s = forkSession(s, newCut);
  s.undo.push(entry);
  s.redo = [];
  s.dirty = true;
  s.revision++;
  acceptSession(s);
  return s;
}
async function exportBlob(w: Core, s: Session, trial: string, format: "cut" | "clu") {
  const i = inputs(s, { recording: source(s, false) });
  const counts = (await ask(w, i, "view")).buffers.counts as Uint32Array;
  const max = counts.findLastIndex((c) => c > 0);
  const head =
    format === "clu"
      ? `${max + 1}\n`
      : `n_clusters: ${max + 1}\nn_channels: 4\nn_params: 0\ntimes_used_in_Vt: 0 0 0 0\n${Array.from({ length: max + 1 }, (_, i) => `cluster: ${i} center: 0 0 0 0 0 0 0 0\nmin: 0 0 0 0 0 0 0 0\nmax: 0 0 0 0 0 0 0 99\n`).join("")}\nExact_cut_for: ${trial} spikes: ${s.n}\n`;
  return new Blob([head, ...(await exportLabels(w, i, format))], {
    type: "application/octet-stream",
  });
}
async function view(
  w: Core,
  s: Session,
  extra: Partial<ComputeInputs> = {},
  cached = true,
  loadMs = 0,
): Promise<ViewMessage> {
  const r = recordings.get(s.asset)!;
  const i = inputs(s, extra);
  const shown = (await ask(w, i, "view")).buffers;
  let population = {};
  if (populationSent !== r.key) {
    const { features, times } = (await ask(w, i, "population")).buffers as Record<
      string,
      Uint8Array & Uint32Array
    >;
    r.duration ||= (times[r.n - 1] || 0) / parseFloat(r.header.timebase);
    population = { features, times };
  }
  populationSent = r.key;
  return {
    key: r.key,
    session: s.key,
    revision: s.revision,
    localCut: s.localCut,
    name: r.file.name,
    n: r.n,
    duration: r.duration,
    timebase: parseFloat(r.header.timebase),
    counts: shown.counts as Uint32Array,
    ...population,
    labels: shown.labels as Uint16Array,
    waveSlots: w.wave_slots(r.n),
    waveOrder: shown.waveOrder as Uint32Array,
    waveStarts: shown.waveStarts as Uint32Array,
    cellHashes: shown.cellHashes as Uint32Array,
    waveHashes: shown.waveHashes as Uint32Array,
    headers: currentHeaders,
    undo: s.undo,
    redo: s.redo,
    dirty: s.dirty,
    cached,
    residentBytes: w.compute_bytes(),
    loadMs,
  };
}
/** One GPU batch of raw resident records. Unsampled batches are a single contiguous
 * Blob slice handed over untouched; sampled ones stream through Rust, which copies
 * only the resident records. */
async function waveBatch(w: Core, r: Recording, first: number, count: number) {
  const slots = w.wave_slots(r.n);
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(count) ||
    first < 0 ||
    count < 1 ||
    first >= slots
  ) {
    throw new Error("Invalid waveform batch.");
  }
  count = Math.min(count, slots - first);
  const r0 = w.wave_record(r.n, first);
  const r1 = w.wave_record(r.n, first + count - 1) + 1;
  const start = r.offset + r0 * 216;
  if (slots === r.n) {
    const bytes = new Uint8Array(await r.file.slice(start, start + count * 216).arrayBuffer());
    if (bytes.length !== count * 216) {
      throw new Error("Truncated file read.");
    }
    return bytes;
  }
  const batch = w.wave_batch_new(r.n, first, count);
  try {
    await streamFile(w, r.file, start, (r1 - r0) * 216, 32768 * 216, (p, bytes, at) =>
      w.wave_batch_feed(batch, r0 + at / 216, p, bytes),
    );
    return copyU8(w, w.wave_batch_data(batch), w.wave_batch_len(batch));
  } finally {
    w.wave_batch_free(batch);
  }
}
async function handle(m: WorkerMessage): Promise<WorkerResult<RequestType>> {
  if (
    splitState &&
    !["split", "analysis", "trajectory", "wave_batch", "features"].includes(m.type)
  ) {
    throw new Error("Finish the waveform split with a left click, or press Escape to cancel.");
  }
  if (m.type === "demo") {
    return demoFiles(await wasmPromise, m.options, (n, message) => progress(m.id, n, message));
  }
  const w = await wasmPromise;
  if (m.type === "features") {
    if (m.mode === "amplitudes") {
      return null;
    }
    const s = active;
    const r = s && recordings.get(s.asset);
    if (!s || !r || r.key !== m.asset) {
      throw new Superseded("Superseded feature calculation.");
    }
    const load = latestLoad;
    if (!Number.isInteger(m.samples) || m.samples < 4 || m.samples > 20000) {
      throw new Error("PCA sample count must be between 4 and 20,000.");
    }
    const samples = Math.min(r.n, m.samples);
    const key = `${r.key}|pca:${samples}`;
    const pca = await ask(
      w,
      inputs(s, {
        settings: { ...defaultSettings, pcaSamples: samples },
        current: () => m.id === latestFeatures && load === latestLoad,
        progress: (fraction, message) => progress(m.id, fraction, message),
      }),
      "pca",
    );
    return {
      asset: r.key,
      key,
      samples,
      values: m.knownKey === key ? undefined : (pca.buffers.values as Float32Array),
    };
  }
  if (m.type === "copy_analysis") {
    if (m.cells.some((cell) => !Number.isInteger(cell) || cell < 0 || cell >= 1024)) {
      throw new Error("Invalid clipboard cell selection.");
    }
    const load = latestLoad;
    const current = () => m.id === latestCopy && load === latestLoad;
    const results = [];
    for (const recording of m.recordings) {
      if (!current()) {
        throw new Superseded("Superseded clipboard selection.");
      }
      // The cut as last left: its session's edits, if it has one.
      const r = await recordingFor(w, recording.assetKey, recording.file);
      const s = sessions.get(`${recording.assetKey}|${recording.cutKey || "unsorted"}`);
      const copied: ComputeInputs = {
        ...recording,
        settings: m.settings,
        recording: s
          ? source(s, false)
          : {
              ...r,
              cut: recording.cut,
              cutSource: recording.cut ? fileId(recording.cut) : "unsorted",
              history: [],
            },
        current,
      };
      // Tile charts omit per-spike overlays; path copies keep selected dots and need the
      // speed dwell, falling back on cell 0 for it.
      const parts: AnalysisPart[] = m.path
        ? ["stats", "spikes", "speedDwell"]
        : ["stats", "spatial", "direction", "speed", "ac", ...(m.spatialAc ? ["sc" as const] : [])];
      const found = new Map<number, AnalysisData>();
      for (const cell of new Set(m.path ? [...m.cells, 0] : m.cells)) {
        found.set(cell, await analysis(w, copied, cell, parts));
      }
      if (!current()) {
        throw new Superseded("Superseded clipboard selection.");
      }
      const cells = m.cells.map((cell) => {
        const data = found.get(cell)!;
        return { cell, spikes: data.count, data: data.count ? data : null };
      });
      const overview = m.path ? cells.find((c) => c.data)?.data || found.get(0) : undefined;
      results.push({
        trialId: recording.trialId,
        cells,
        position: overview
          ? {
              trajectory: await trajectory(w, copied),
              overview: { ...overview, spikes: new Float32Array() },
              header: {
                ...r.header,
                ...(recording.pos ? await positionHeader(recording.pos) : {}),
                ...(recording.set ? textHeader(await recording.set.text()) : {}),
              },
              duration: r.duration,
            }
          : undefined,
      });
    }
    return results;
  }
  if (m.type === "load") {
    const key = m.assetKey as string;
    const sessionKey = `${key}|${m.cut ? m.cutKey : "unsorted"}`;
    const cached = recordings.has(key);
    const start = performance.now();
    const r = await recordingFor(w, key, m.file);
    let s = sessions.get(sessionKey);
    if (!s) {
      s = {
        key: sessionKey,
        asset: key,
        cut: m.cut,
        cutSource: m.cut ? fileId(m.cut) : "unsorted",
        undo: [],
        redo: [],
        dirty: false,
        revision: 0,
        n: r.n,
      };
      sessions.set(sessionKey, s);
    }
    currentHeaders = { tetrode: r.header };
    if (s.localCut) {
      currentHeaders.cut = { file: s.localCut.name, source: "Modified cut" };
    } else if (m.cut) {
      const file = m.cut as File;
      const text = await file.slice(0, 65536).text();
      const end = text.indexOf("Exact_cut_for:");
      currentHeaders.cut = {
        file: file.name,
        ...(end >= 0
          ? textHeader(text.slice(0, text.indexOf("\n", end)))
          : { clusters: text.split(/\s+/)[0], label_base: "1" }),
      };
    }
    if (m.set) {
      currentHeaders.set = textHeader(await (m.set as File).text());
    }
    if (m.pos) {
      currentHeaders.position = parseHeader(
        new Uint8Array(await (m.pos as File).slice(0, 65536).arrayBuffer()),
      ).header;
    }
    const shown = await view(
      w,
      s,
      {
        current: () => m.id === latestLoad,
        progress: (fraction, message) => progress(m.id, fraction, message),
      },
      cached,
      performance.now() - start,
    );
    active = s;
    return shown;
  }
  if (m.type === "export_cut") {
    const target = sessions.get(m.session);
    if (!target) {
      throw new Error("Cut state is unavailable.");
    }
    if (m.revision !== undefined && target.revision !== m.revision) {
      throw new Superseded("Superseded cut export.");
    }
    return exportBlob(w, target, m.trial, "cut");
  }
  if (!active) {
    throw new Error("Load a tetrode first.");
  }
  let s = active;
  const r = recordings.get(s.asset)!;
  if ("session" in m && m.session && m.session !== s.key) {
    throw new Error("The active cut changed; retry the operation.");
  }
  if (m.type === "split") {
    try {
      if (m.phase === "preview") {
        if (!splitState) {
          if (!Number.isInteger(m.source) || m.source < 0 || m.source >= 1023) {
            throw new Error("No room to insert another cell.");
          }
          splitState = { ...m };
        }
        if (
          !Number.isInteger(m.channel) ||
          m.channel < 0 ||
          m.channel > 3 ||
          !Number.isInteger(m.sample) ||
          m.sample < 0 ||
          m.sample > 49
        ) {
          throw new Error("Invalid waveform split point.");
        }
        // Each threshold is its own patch, shown but not applied until the split finishes.
        const id = crypto.randomUUID();
        const { source: cell } = splitState;
        const { changed, patch } = await command(
          w,
          inputs(s, {
            recording: source(s, false),
            patch: id,
            progress: (fraction, message) => progress(m.id, fraction, message),
          }),
          () => w.command_split(cell, m.channel, m.sample, m.threshold),
        );
        s.preview = changed ? { id, patch, changed } : undefined;
        splitState = {
          ...splitState,
          channel: m.channel,
          sample: m.sample,
          threshold: m.threshold,
        };
      } else if (splitState) {
        if (m.phase === "finish" && s.preview) {
          const { id, patch, changed } = s.preview;
          const entry = {
            id,
            description: `Split cell ${splitState.source} at Ch ${splitState.channel + 1}, sample ${splitState.sample}, > ${splitState.threshold}`,
            changed,
          };
          s = await record(s, entry, patch, m.newCut);
        }
        s.preview = undefined;
        splitState = undefined;
      }
      s.revision++;
      return view(w, s);
    } catch (error) {
      s.preview = undefined;
      splitState = undefined;
      s.revision++;
      throw error;
    }
  }
  if (m.type === "view") {
    return view(w, s);
  }
  if (m.type === "edit") {
    if (!Number.isInteger(m.dest) || m.dest < 0 || m.dest >= 1024) {
      throw new Error("Destination cell must be 0–1023.");
    }
    const id = crypto.randomUUID();
    let settings = defaultSettings;
    let run: () => number;
    if (m.action === "polygon" || m.action === "paint") {
      // PCA edits name the PCA they were drawn on (see the features request).
      const pca = m.featureKey?.startsWith(`${r.key}|pca:`)
        ? Number(m.featureKey.slice(r.key.length + 5))
        : undefined;
      if (m.featureKey && !(Number.isInteger(pca) && pca! >= 4)) {
        throw new Superseded("PCA basis changed; redraw the selection.");
      }
      if (pca) {
        settings = { ...defaultSettings, pcaSamples: pca };
      }
      const offset = m.featureKey ? 5 : 0;
      const projected = m.projection;
      if (
        projected &&
        (projected.matrix.length !== 12 ||
          projected.axes.length !== 3 ||
          new Set(projected.axes).size !== 3 ||
          !projected.axes.every((axis) => Number.isInteger(axis) && axis >= 0 && axis < 4) ||
          !projected.matrix.every(Number.isFinite) ||
          !Number.isInteger(projected.width) ||
          projected.width < 1 ||
          projected.width > 16384 ||
          !Number.isInteger(projected.height) ||
          projected.height < 1 ||
          projected.height > 16384)
      ) {
        throw new Error("Invalid 3D view; redraw the selection.");
      }
      run = () =>
        withU16(w, m.sources, (p, n) =>
          withF32(w, m.polygon, (q, count) =>
            projected
              ? withU16(w, projected.axes, (axes) =>
                  withF32(w, projected.matrix, (matrix) =>
                    w.command_region(
                      p,
                      n,
                      m.dest,
                      offset,
                      axes,
                      matrix,
                      q,
                      count,
                      m.action === "paint" ? 9 : 0,
                      projected.width,
                      projected.height,
                    ),
                  ),
                )
              : m.action === "paint"
                ? w.command_brush(p, n, m.dest, m.ax + offset, m.ay + offset, q, count)
                : w.command_polygon(p, n, m.dest, m.ax + offset, m.ay + offset, q, count),
          ),
        );
    } else {
      const { source: from } = m;
      run = () => w.command_relabel(from, m.dest, m.action === "swap" ? 1 : 0);
    }
    const { changed, patch } = await command(w, inputs(s, { settings, patch: id }), run);
    if (changed) {
      s = await record(s, { id, description: m.description, changed }, patch, m.newCut);
    }
    return view(w, s);
  }
  if (m.type === "undo" || m.type === "redo") {
    const from = m.type === "undo" ? s.undo : s.redo;
    const to = m.type === "undo" ? s.redo : s.undo;
    const entry = from.pop();
    if (entry) {
      to.push(entry);
      try {
        // The labels at the new point of the history, usually still kept.
        const shown = await view(w, s);
        s.dirty = true;
        s.revision++;
        return { ...shown, revision: s.revision, dirty: true };
      } catch (error) {
        to.pop();
        from.push(entry);
        throw error;
      }
    }
    return view(w, s);
  }
  if (m.type === "wave_batch") {
    if (m.asset !== r.key) {
      throw new Superseded("Superseded waveform batch.");
    }
    return { waves: await waveBatch(w, r, m.first, m.count) };
  }
  if (m.type === "trajectory") {
    return trajectory(w, m);
  }
  if (m.type === "analysis") {
    const i = { ...m, recording: source(s) };
    const result = await analysis(w, i, m.cell, m.parts);
    // The membership analysed, so the page can tell if its cut moved on.
    const [count, lo, hi] = (await ask(w, i, "membership", m.cell)).buffers.membership;
    return { ...result, membership: `${count}:${lo}:${hi}` };
  }
  if (m.type === "export") {
    return exportBlob(w, s, m.trial, m.format);
  }

  // Unreachable while every request type is handled above (m is `never` here).
  throw new Error(`Unknown operation: ${(m as { type: string }).type}`);
}
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent) => {
  const m = event.data as WorkerMessage | { type: "init"; url: string };
  if (m.type === "init") {
    wasmPromise = fetch(m.url)
      .then(async (r) => {
        if (!r.ok) {
          throw new Error("Rust/Wasm module missing; run npm run build:wasm.");
        }
        return WebAssembly.instantiate(await WebAssembly.compile(await r.arrayBuffer()), {});
      })
      .then((x) => x.exports as Core);
    return;
  }
  if (m.type === "load") {
    latestLoad = m.id;
  }
  if (m.type === "features") {
    latestFeatures = m.id;
  }
  if (m.type === "copy_analysis") {
    latestCopy = m.id;
  }
  if (m.type === "analysis" && m.batch) {
    latestAnalysisBatch = m.batch;
  }
  queue = queue.then(async () => {
    try {
      if (m.type === "load" && m.id !== latestLoad) {
        throw new Superseded("Superseded by another recording.");
      }
      if (m.type === "copy_analysis" && m.id !== latestCopy) {
        throw new Superseded("Superseded clipboard selection.");
      }
      if (m.type === "analysis" && m.batch && m.batch !== latestAnalysisBatch) {
        throw new Superseded("Superseded analysis.");
      }
      const data = await handle(m);
      // Results are fresh copies (cached values stay in Rust), so their buffers move to
      // the page rather than being copied again. Clipboard results nest theirs per trial.
      const transfer = new Set<ArrayBuffer>();
      const collect = (value: unknown, nested: boolean) => {
        if (ArrayBuffer.isView(value)) {
          transfer.add(value.buffer as ArrayBuffer);
        } else if (nested && value && typeof value === "object") {
          Object.values(value).forEach((v) => collect(v, true));
        }
      };
      if (data && typeof data === "object") {
        Object.values(data).forEach((v) => collect(v, m.type === "copy_analysis"));
      }
      self.postMessage({ id: m.id, data }, [...transfer]);
    } catch (error) {
      self.postMessage({
        id: m.id,
        error: error instanceof Error ? error.message : String(error),
        superseded: error instanceof Superseded,
      });
    }
  });
};
