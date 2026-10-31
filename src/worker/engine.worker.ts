/// <reference lib="webworker" />
// Owns browser handles and asynchronous scheduling. Rust owns population data and
// every loop over spike, label, waveform and position records.
import { demoFiles, recordingSource } from "./demo";
import { parseHeader, textHeader, readCut } from "../files";
import type { Settings, Header, HistoryEntry, ViewMessage, AnalysisData } from "../types";
import { parsePosition, analyse, trajectory, type Position } from "./position";
import { openStore, put, get } from "./history";
import { streamFile, copyU8, copyU16, copyU32, withU16, withF32, type Core } from "./wasm";
import { Superseded } from "./protocol";
import { readRecording } from "./recording";
import { fitPca } from "./pca";
import type { PositionRequest, RequestType, WorkerMessage, WorkerResult } from "./protocol";
interface Asset {
  key: string;
  wasm: Core;
  e: number;
  n: number;
  header: Header;
  offset: number;
  file: File;
  ms: number;
  last: number;
  pcaKey?: string;
}
interface Session {
  key: string;
  asset: string;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  dirty: boolean;
  revision: number;
  n: number;
  localCut?: { id: string; name: string };
}
const assets = new Map<string, Asset>();
const sessions = new Map<string, Session>();
const positions = new Map<string, Position>();
const analyses = new Map<string, AnalysisData>();
let wasmPromise: Promise<Core>;
let latestLoad = 0;
let latestCopy = 0;
let latestFeatures = 0;
let active: Session | undefined;
let activeAsset: Asset | undefined;
const dbPromise = openStore();
let latestAnalysisBatch = "";
let splitState: { source: number; channel: number; sample: number; threshold: number } | undefined;
let currentHeaders: Record<string, Header> = {};
// Amplitudes and timestamps never change for a recording, so they are sent only
// when the recording changes; client.ts reattaches them to later views.
let populationSent = "";
const labels = (a: Asset) => new Uint16Array(a.wasm.memory.buffer, a.wasm.engine_labels(a.e), a.n);
const times = (a: Asset) => new Uint32Array(a.wasm.memory.buffer, a.wasm.engine_times(a.e), a.n);
const counts = (a: Asset) => new Uint32Array(a.wasm.memory.buffer, a.wasm.engine_counts(a.e), 1024);
const resident = () =>
  [...assets.values()].reduce((n, a) => n + a.wasm.engine_resident_bytes(a.e), 0);
function progress(id: number, value: number, message: string) {
  self.postMessage({ id, progress: value, message });
}
async function saveActive() {
  if (active && activeAsset) {
    await put(await dbPromise, `labels:${active.key}`, labels(activeAsset).slice());
  }
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
function exportLabels(w: Core, e: number, n: number, trial: string, format: string): Blob {
  const max = new Uint32Array(w.memory.buffer, w.engine_counts(e), 1024).findLastIndex(
    (c) => c > 0,
  );
  const parts: BlobPart[] = [];
  parts.push(
    format === "clu"
      ? `${max + 1}\n`
      : `n_clusters: ${max + 1}\nn_channels: 4\nn_params: 0\ntimes_used_in_Vt: 0 0 0 0\n${Array.from({ length: max + 1 }, (_, i) => `cluster: ${i} center: 0 0 0 0 0 0 0 0\nmin: 0 0 0 0 0 0 0 0\nmax: 0 0 0 0 0 0 0 99\n`).join("")}\nExact_cut_for: ${trial} spikes: ${n}\n`,
  );
  for (let first = 0; first < n; first += 65536) {
    w.engine_export_chunk(e, first, 65536, format === "clu" ? 1 : 0);
    parts.push(copyU8(w, w.engine_output(e), w.engine_output_len(e)).buffer);
  }
  return new Blob(parts, { type: "application/octet-stream" });
}
function evict(required: number) {
  for (const [key, a] of [...assets].sort((a, b) => a[1].last - b[1].last)) {
    if (resident() + required <= 384 * 1024 * 1024) {
      break;
    }
    if (active?.asset === key) {
      continue;
    }
    assets.delete(key);
    a.wasm.engine_free(a.e);
  }
}
async function loadAsset(
  file: File,
  cut: File | undefined,
  id: number,
  key: string,
): Promise<Asset> {
  const cached = assets.get(key);
  if (cached) {
    cached.last = performance.now();
    return cached;
  }
  evict(Math.ceil(file.size / 216) * 12 + 30000000);
  const wasm = await wasmPromise;
  const recording = await readRecording(wasm, file, cut, {
    current: () => id === latestLoad,
    progress: (fraction, n) =>
      progress(
        id,
        fraction,
        `Preparing ${Math.round(fraction * n).toLocaleString()} / ${n.toLocaleString()} spikes`,
      ),
  });
  const a: Asset = { ...recording, key, wasm, last: performance.now() };
  assets.set(key, a);
  return a;
}
function view(a: Asset, s: Session, cached: boolean): ViewMessage {
  const w = a.wasm;
  const e = a.e;
  w.engine_build_wave_order(e);
  const population =
    populationSent === a.key
      ? {}
      : {
          features: copyU8(w, w.engine_amps(e), a.n * 4),
          times: copyU32(w, w.engine_times(e), a.n),
        };
  populationSent = a.key;
  return {
    key: a.key,
    session: s.key,
    revision: s.revision,
    localCut: s.localCut,
    name: a.file.name,
    n: a.n,
    duration:
      parseFloat(a.header.duration) || (times(a)[a.n - 1] || 0) / parseFloat(a.header.timebase),
    timebase: parseFloat(a.header.timebase),
    counts: counts(a).slice(),
    ...population,
    labels: copyU16(w, w.engine_labels(e), a.n),
    waveSlots: w.engine_wave_slots(e),
    waveOrder: copyU32(w, w.engine_wave_order(e), w.engine_wave_order_len(e)),
    waveStarts: copyU32(w, w.engine_wave_starts(e), w.engine_wave_starts_len(e)),
    cellHashes: copyU32(w, w.engine_cell_hashes(e), 2048),
    waveHashes: copyU32(w, w.engine_wave_hashes(e), w.engine_wave_hashes_len(e)),
    headers: currentHeaders,
    undo: s.undo,
    redo: s.redo,
    dirty: s.dirty,
    cached,
    residentBytes: resident(),
    loadMs: a.ms,
  };
}
/** One GPU batch of raw resident records. Unsampled batches are a single contiguous
 * Blob slice handed over untouched; sampled ones stream through Rust, which copies
 * only the resident records. */
async function waveBatch(a: Asset, first: number, count: number) {
  const w = a.wasm;
  const e = a.e;
  const slots = w.engine_wave_slots(e);
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
  const r0 = w.engine_wave_record(e, first);
  const r1 = w.engine_wave_record(e, first + count - 1) + 1;
  const start = a.offset + r0 * 216;
  if (slots === a.n) {
    const bytes = new Uint8Array(await a.file.slice(start, start + count * 216).arrayBuffer());
    if (bytes.length !== count * 216) {
      throw new Error("Truncated file read.");
    }
    return bytes;
  }
  w.engine_wave_begin(e, first, count);
  await streamFile(w, a.file, start, (r1 - r0) * 216, 32768 * 216, (p, bytes, at) =>
    w.engine_wave_feed(e, r0 + at / 216, p, bytes),
  );
  return copyU8(w, w.engine_wave_batch(e), w.engine_wave_batch_len(e));
}
async function waveformColumn(a: Asset, channel: number, sample: number, id: number) {
  const w = a.wasm;
  const e = a.e;
  const cached = w.engine_gate_begin(e, channel, sample);
  if (cached < 0) {
    throw new Error("Invalid waveform gate.");
  }
  if (cached) {
    return;
  }
  await streamFile(
    w,
    a.file,
    a.offset,
    a.n * 216,
    32768 * 216,
    (p, bytes, first) => w.engine_gate_feed(e, first / 216, p, bytes),
    (fraction) =>
      progress(
        id,
        fraction,
        `Preparing waveform gate ${Math.round(fraction * a.n).toLocaleString()} / ${a.n.toLocaleString()}`,
      ),
  );
}
const positionKey = (m: PositionRequest) =>
  m.pos ? `${m.posKey}|${m.settings.leds}|${m.settings.maxSpeed}|${m.settings.posSmooth}` : "";
/** The processed position for a request, parsed once per file and LED/speed settings. */
async function positionFor(m: PositionRequest, w: Core) {
  const pk = positionKey(m);
  let pos = positions.get(pk);
  if (m.pos && !pos) {
    const base = [...positions.values()].find((p) => p.identity === m.posKey);
    pos = await parsePosition(m.pos, m.settings, w, m.posKey, base);
    positions.set(pk, pos);
    if (positions.size > 4) {
      const oldest = positions.keys().next().value!;
      w.position_free(positions.get(oldest)!.handle);
      positions.delete(oldest);
    }
  }
  return pos;
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
  if (m.type === "features") {
    if (m.mode === "amplitudes") {
      return null;
    }
    const a = activeAsset;
    if (!a || a.key !== m.asset) {
      throw new Superseded("Superseded feature calculation.");
    }
    const load = latestLoad;
    const check = () => {
      if (m.id !== latestFeatures || load !== latestLoad) {
        throw new Superseded("Superseded feature calculation.");
      }
    };
    check();
    if (!Number.isInteger(m.samples) || m.samples < 4 || m.samples > 20000) {
      throw new Error("PCA sample count must be between 4 and 20,000.");
    }
    const samples = Math.min(a.n, m.samples);
    const key = `${a.key}|pca:${samples}`;
    const w = await wasmPromise;
    if (a.pcaKey !== key) {
      a.pcaKey = undefined;
      w.engine_pca_clear(a.e);
      evict(a.n * 16 + 20_000_000);
      await fitPca(w, a, m.samples, check, (fraction, message) =>
        progress(m.id, fraction, message),
      );
      a.pcaKey = key;
    }
    return {
      asset: a.key,
      key,
      samples,
      values:
        m.knownKey === key
          ? undefined
          : new Float32Array(
              w.memory.buffer,
              w.engine_pca_values(a.e),
              w.engine_pca_values_len(a.e),
            ).slice(),
    };
  }
  if (m.type === "copy_analysis") {
    if (m.cells.some((cell) => !Number.isInteger(cell) || cell < 0 || cell >= 1024)) {
      throw new Error("Invalid clipboard cell selection.");
    }
    const load = latestLoad;
    const current = () => m.id === latestCopy && load === latestLoad;
    const results = [];
    const w = await wasmPromise;
    // Only one temporary population is resident at a time. This never builds a
    // waveform order, sends a view, or changes the active engine/cut/headers.
    for (const recording of m.recordings) {
      if (!current()) {
        throw new Superseded("Superseded clipboard selection.");
      }
      const session = sessions.get(`${recording.assetKey}|${recording.cutKey || "unsorted"}`);
      const live = m.path && session?.key === active?.key ? activeAsset : undefined;
      const saved =
        session && !live
          ? await get<Uint16Array>(await dbPromise, `labels:${session.key}`)
          : undefined;
      if (session?.localCut && !saved && !live) {
        throw new Error("Modified cut state is unavailable.");
      }
      let a = live;
      if (!a) {
        const file = recordingSource(w, recording.file);
        evict(Math.ceil(file.size / 216) * 12 + 30000000);
        const recordingData = await readRecording(w, file, saved ? undefined : recording.cut, {
          current,
        });
        a = { ...recordingData, key: recording.assetKey, wasm: w, last: performance.now() };
      }
      try {
        if (saved) {
          if (saved.length !== a.n) {
            throw new Error("Saved cut does not match its recording.");
          }
          new Uint16Array(w.memory.buffer, w.engine_labels(a.e), a.n).set(saved);
          w.engine_recount(a.e);
        }
        const pos = await positionFor({ ...recording, settings: m.settings }, w);
        if (!current()) {
          throw new Superseded("Superseded clipboard selection.");
        }
        const counts = new Uint32Array(w.memory.buffer, w.engine_counts(a.e), 1024).slice();
        const timebase = parseFloat(a.header.timebase);
        const times = new Uint32Array(w.memory.buffer, w.engine_times(a.e), a.n);
        const duration = parseFloat(a.header.duration) || (times[a.n - 1] || 0) / timebase;
        const cells = m.cells.map((cell) => {
          const data = counts[cell]
            ? analyse(w, a.e, cell, timebase, duration, pos, m.settings, m.spatialAc)
            : null;
          // Tile charts omit per-spike overlays; path copies retain selected dots.
          return {
            cell,
            spikes: counts[cell],
            data: data && (m.path ? data : { ...data, spikes: new Float32Array() }),
          };
        });
        const overview = m.path
          ? cells.find((c) => c.data)?.data ||
            analyse(w, a.e, 0, timebase, duration, pos, m.settings)
          : undefined;
        const header = overview
          ? {
              ...a.header,
              ...pos?.header,
              ...(recording.set ? textHeader(await recording.set.text()) : {}),
            }
          : a.header;
        results.push({
          trialId: recording.trialId,
          cells,
          position: overview
            ? {
                trajectory: pos ? trajectory(w, pos) : null,
                overview: { ...overview, spikes: new Float32Array() },
                header,
                duration,
              }
            : undefined,
        });
      } finally {
        if (!live) {
          w.engine_free(a.e);
        }
      }
    }
    return results;
  }
  if (m.type === "load") {
    await saveActive();
    const key = m.assetKey as string;
    const sessionKey = `${key}|${m.cut ? m.cutKey : "unsorted"}`;
    const cached = assets.has(key);
    const existing = sessions.get(sessionKey);
    const a = await loadAsset(
      recordingSource(await wasmPromise, m.file),
      existing?.localCut ? undefined : m.cut,
      m.id,
      key,
    );
    let s = sessions.get(sessionKey);
    if (!s) {
      s = {
        key: sessionKey,
        asset: key,
        undo: [],
        redo: [],
        dirty: false,
        revision: 0,
        n: a.n,
      };
      sessions.set(sessionKey, s);
      if (cached) {
        if (m.cut) {
          await readCut(m.cut, a.n, a.wasm, a.e);
        } else {
          a.wasm.engine_unsorted(a.e);
        }
      }
    } else {
      const stored = await get<Uint16Array>(await dbPromise, `labels:${sessionKey}`);
      if (stored) {
        labels(a).set(stored);
      } else if (s.localCut) {
        throw new Error("Modified cut state is unavailable.");
      } else if (m.cut) {
        await readCut(m.cut, a.n, a.wasm, a.e);
      } else {
        a.wasm.engine_unsorted(a.e);
      }
    }
    a.wasm.engine_recount(a.e);
    active = s;
    activeAsset = a;
    currentHeaders = { tetrode: a.header };
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
    return view(a, s, cached);
  }
  if (m.type === "export_cut") {
    const target = sessions.get(m.session);
    if (!target) {
      throw new Error("Cut state is unavailable.");
    }
    if (m.revision !== undefined && target.revision !== m.revision) {
      throw new Superseded("Superseded cut export.");
    }
    if (active?.key === target.key && activeAsset) {
      return exportLabels(activeAsset.wasm, activeAsset.e, activeAsset.n, m.trial, "cut");
    }
    const saved = await get<Uint16Array>(await dbPromise, `labels:${target.key}`);
    if (!saved || saved.length !== target.n) {
      throw new Error("Cut labels are unavailable.");
    }
    const w = await wasmPromise;
    const e = w.engine_new_cut(target.n);
    try {
      new Uint16Array(w.memory.buffer, w.engine_labels(e), target.n).set(saved);
      w.engine_recount(e);
      return exportLabels(w, e, target.n, m.trial, "cut");
    } finally {
      w.engine_free(e);
    }
  }
  if (!active || !activeAsset) {
    throw new Error("Load a tetrode first.");
  }
  const a = activeAsset;
  const w = a.wasm;
  const e = a.e;
  let s = active;
  if ("session" in m && m.session && m.session !== s.key) {
    throw new Error("The active cut changed; retry the operation.");
  }
  if (m.type === "split") {
    try {
      if (m.phase === "preview") {
        if (!splitState) {
          if (!Number.isInteger(m.source) || m.source < 0 || m.source >= 1023 || counts(a)[1023]) {
            throw new Error("No room to insert another cell.");
          }
          if (!s.localCut) {
            await saveActive();
          }
          w.engine_edit_begin(e);
          w.engine_split_cache_begin(e, m.source);
          splitState = {
            source: m.source,
            channel: m.channel,
            sample: m.sample,
            threshold: m.threshold,
          };
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
        if (!w.engine_split_cached(e)) {
          await waveformColumn(a, m.channel, m.sample, m.id);
          w.engine_split_cache_finish(e);
        }
        if (w.engine_split_gate(e, splitState.source, m.channel, m.sample, m.threshold) < 0) {
          throw new Error("No room to insert another cell.");
        }
        splitState = {
          ...splitState,
          channel: m.channel,
          sample: m.sample,
          threshold: m.threshold,
        };
      } else if (splitState) {
        if (m.phase === "cancel") {
          w.engine_edit_rollback(e);
        } else {
          const changed = w.engine_edit_finish(e);
          if (changed) {
            const entry = {
              id: crypto.randomUUID(),
              description: `Split cell ${splitState.source} at Ch ${splitState.channel + 1}, sample ${splitState.sample}, > ${splitState.threshold}`,
              changed,
            };
            const patch = copyU8(w, w.engine_patch(e), w.engine_patch_len(e));
            await put(await dbPromise, `patch:${entry.id}`, patch);
            s = forkSession(s, m.newCut);
            s.undo.push(entry);
            s.redo = [];
            s.dirty = true;
            acceptSession(s);
          }
        }
        w.engine_patch_clear(e);
        splitState = undefined;
      }
      s.revision++;
      return view(a, s, true);
    } catch (error) {
      w.engine_edit_rollback(e);
      w.engine_patch_clear(e);
      splitState = undefined;
      s.revision++;
      throw error;
    }
  }
  if (m.type === "view") {
    return view(a, s, true);
  }
  if (m.type === "edit") {
    if (!Number.isInteger(m.dest) || m.dest < 0 || m.dest >= 1024) {
      throw new Error("Destination cell must be 0–1023.");
    }
    if (m.newCut) {
      await saveActive();
    }
    w.engine_edit_begin(e);
    let changed = 0;
    try {
      if (m.action === "polygon" || m.action === "paint") {
        if (m.featureKey && m.featureKey !== a.pcaKey) {
          throw new Superseded("PCA basis changed; redraw the selection.");
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
        withU16(w, m.sources, (p, n) =>
          withF32(w, m.polygon, (q, count) =>
            projected
              ? withU16(w, projected.axes, (axes) =>
                  withF32(w, projected.matrix, (matrix) =>
                    w.engine_projected_region(
                      e,
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
                ? w.engine_brush(e, p, n, m.dest, m.ax + offset, m.ay + offset, q, count)
                : w.engine_polygon(e, p, n, m.dest, m.ax + offset, m.ay + offset, q, count),
          ),
        );
      } else {
        w.engine_relabel(e, m.source, m.dest, m.action === "swap" ? 1 : 0);
      }
      changed = w.engine_edit_finish(e);
      if (changed) {
        const entry = {
          id: crypto.randomUUID(),
          description: m.description,
          changed,
        };
        const patch = copyU8(w, w.engine_patch(e), w.engine_patch_len(e));
        try {
          await put(await dbPromise, `patch:${entry.id}`, patch);
        } catch (error) {
          throw new Error(`Edit rolled back: undo storage is unavailable (${String(error)}).`);
        }
        s = forkSession(s, m.newCut);
        s.undo.push(entry);
        s.redo = [];
        s.dirty = true;
        s.revision++;
        acceptSession(s);
      }
    } catch (error) {
      w.engine_edit_rollback(e);
      throw error;
    } finally {
      w.engine_patch_clear(e);
    }
    return view(a, s, true);
  }
  if (m.type === "undo" || m.type === "redo") {
    const from = m.type === "undo" ? s.undo : s.redo;
    const to = m.type === "undo" ? s.redo : s.undo;
    const entry = from.at(-1);
    if (entry) {
      const patch = await get<Uint8Array>(await dbPromise, `patch:${entry.id}`);
      if (!patch) {
        throw new Error("Undo data is unavailable.");
      }
      const p = w.alloc_bytes(patch.byteLength);
      try {
        new Uint8Array(w.memory.buffer, p, patch.byteLength).set(patch);
        if (w.engine_patch_apply(e, p, patch.byteLength, m.type === "redo" ? 1 : 0)) {
          throw new Error("Invalid undo data.");
        }
      } finally {
        w.free_bytes(p, patch.byteLength);
      }
      from.pop();
      to.push(entry);
      s.dirty = true;
      s.revision++;
    }
    return view(a, s, true);
  }
  if (m.type === "wave_batch") {
    if (m.asset !== a.key) {
      throw new Superseded("Superseded waveform batch.");
    }
    return { waves: await waveBatch(a, m.first, m.count) };
  }
  if (m.type === "trajectory") {
    const pos = await positionFor(m, w);
    return pos ? trajectory(w, pos) : null;
  }
  if (m.type === "analysis") {
    const opts = m.settings as Settings;
    const pos = await positionFor(m, w);
    // Keyed by the cell's spike set rather than its number or the cut
    // revision, so edits only recompute cells whose membership changed.
    const hashes = new Uint32Array(w.memory.buffer, w.engine_cell_hashes(e), 2048);
    const membership = `${counts(a)[m.cell]}:${hashes[m.cell * 2]}:${hashes[m.cell * 2 + 1]}`;
    const key = `${a.key}|${membership}|${positionKey(m)}|${opts.binCm}|${opts.smooth}|${opts.acWindow}|${opts.dirBin}|${opts.speedBin}|${opts.speedMax}|SC:${m.spatialAc ? opts.scMinOverlap : "off"}`;
    let result = analyses.get(key);
    if (result) {
      analyses.delete(key);
    } else {
      result = analyse(
        w,
        e,
        m.cell,
        parseFloat(a.header.timebase),
        parseFloat(a.header.duration) || (times(a)[a.n - 1] || 0) / parseFloat(a.header.timebase),
        pos,
        opts,
        m.spatialAc,
      );
      if (analyses.size >= 200) {
        analyses.delete(analyses.keys().next().value!);
      }
      evict(0);
    }
    analyses.set(key, result);
    const answer = { ...result, cell: m.cell, membership };
    return m.summary ? { ...answer, spikes: new Float32Array() } : answer;
  }
  if (m.type === "export") {
    return exportLabels(w, e, a.n, m.trial, m.format);
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
      const transfer: Transferable[] = [];
      if (data && m.type !== "analysis") {
        for (const value of Object.values(data)) {
          if (ArrayBuffer.isView(value)) {
            transfer.push(value.buffer as ArrayBuffer);
          }
        }
      }
      self.postMessage({ id: m.id, data }, transfer);
    } catch (error) {
      self.postMessage({
        id: m.id,
        error: error instanceof Error ? error.message : String(error),
        superseded: error instanceof Superseded,
      });
    }
  });
};
