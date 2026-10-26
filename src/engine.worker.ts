/// <reference lib="webworker" />
// Owns browser handles and asynchronous scheduling. Rust owns population data and
// every loop over spike, label, waveform and position records.
import { parseHeader, textHeader, readCut } from "./files";
import type { Settings, Header, HistoryEntry, ViewData } from "./types";
import { parsePosition, analyse, type Position } from "./position";
import { openStore, put, get } from "./history";
import {
  streamFile,
  copyU8,
  copyI8,
  copyU16,
  copyU32,
  copyF32,
  withU16,
  withF32,
  type Core,
} from "./wasm";
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
const assets = new Map<string, Asset>(),
  sessions = new Map<string, Session>(),
  positions = new Map<string, Position>(),
  analyses = new Map<string, unknown>();
let wasmPromise: Promise<Core>,
  latestLoad = 0,
  active: Session | undefined,
  activeAsset: Asset | undefined;
const dbPromise = openStore();
let latestAnalysisBatch = "";
let splitState:
  | { source: number; channel: number; sample: number; threshold: number }
  | undefined;
let currentHeaders: Record<string, Header> = {},
  budget = 250000;
const labels = (a: Asset) =>
  new Uint16Array(a.wasm.memory.buffer, a.wasm.engine_labels(a.e), a.n);
const times = (a: Asset) =>
  new Uint32Array(a.wasm.memory.buffer, a.wasm.engine_times(a.e), a.n);
const counts = (a: Asset) =>
  new Uint32Array(a.wasm.memory.buffer, a.wasm.engine_counts(a.e), 1024);
const resident = () =>
  [...assets.values()].reduce(
    (n, a) => n + a.wasm.engine_resident_bytes(a.e),
    0,
  );
function progress(id: number, value: number, message: string) {
  self.postMessage({ id, progress: value, message });
}
async function saveActive() {
  if (active && activeAsset)
    await put(
      await dbPromise,
      `labels:${active.key}`,
      labels(activeAsset).slice(),
    );
}
function forkSession(s: Session, descriptor: any): Session {
  if (
    !descriptor ||
    typeof descriptor.id !== "string" ||
    typeof descriptor.name !== "string"
  )
    return s;
  const key = `${s.asset}|${descriptor.id}`;
  if (sessions.has(key)) throw new Error("Cut identity already exists.");
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
  if (s.localCut)
    currentHeaders.cut = { file: s.localCut.name, source: "Modified cut" };
}
function exportLabels(
  w: Core,
  e: number,
  n: number,
  trial: string,
  format: string,
): Blob {
  const max = new Uint32Array(
      w.memory.buffer,
      w.engine_counts(e),
      1024,
    ).findLastIndex((c) => c > 0),
    parts: BlobPart[] = [];
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
    if (resident() + required <= 384 * 1024 * 1024) break;
    if (active?.asset === key) continue;
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
  const start = performance.now(),
    head = new Uint8Array(await file.slice(0, 65536).arrayBuffer()),
    { header, offset } = parseHeader(head);
  let n = parseInt(header.num_spikes);
  if (
    header.spike_format !== "t,ch1,t,ch2,t,ch3,t,ch4" ||
    parseInt(header.samples_per_spike || "50") !== 50 ||
    parseInt(header.num_chans || "4") !== 4 ||
    parseInt(header.bytes_per_sample || "1") !== 1 ||
    parseInt(header.bytes_per_timestamp || "4") !== 4
  )
    throw new Error(
      "Supported tetrodes have 4 channels, 50 signed 8-bit samples, and 32-bit timestamps.",
    );
  if (
    new TextDecoder()
      .decode(head.subarray(offset, offset + 10))
      .startsWith("\r\ndata_end")
  )
    n = 0;
  if (
    !Number.isSafeInteger(n) ||
    n < 0 ||
    n > 20_000_000 ||
    file.size < offset + n * 216 ||
    !(parseFloat(header.timebase) > 0)
  )
    throw new Error("Invalid/truncated tetrode or unsupported spike count.");
  evict(n * 12 + 30000000);
  const wasm = await wasmPromise,
    e = wasm.engine_new(n),
    a: Asset = {
      key,
      wasm,
      e,
      n,
      header,
      offset,
      file,
      ms: 0,
      last: performance.now(),
    };
  try {
    if (cut) await readCut(cut, n, wasm, e);
    await streamFile(
      wasm,
      file,
      offset,
      n * 216,
      32768 * 216,
      (p, bytes) => {
        if (id !== latestLoad)
          throw new Error("Superseded by another recording.");
        wasm.engine_push(e, p, bytes);
      },
      (fraction) =>
        progress(
          id,
          fraction,
          `Preparing ${Math.round(fraction * n).toLocaleString()} / ${n.toLocaleString()} spikes`,
        ),
    );
    wasm.engine_samples_finish(e);
    wasm.engine_recount(e);
    a.ms = performance.now() - start;
    assets.set(key, a);
    return a;
  } catch (error) {
    wasm.engine_free(e);
    throw error;
  }
}
function view(a: Asset, s: Session, cached: boolean): ViewData {
  const w = a.wasm,
    e = a.e;
  w.engine_prepare_view(e, budget);
  return {
    key: a.key,
    session: s.key,
    revision: s.revision,
    localCut: s.localCut,
    name: a.file.name,
    n: a.n,
    duration:
      parseFloat(a.header.duration) ||
      (times(a)[a.n - 1] || 0) / parseFloat(a.header.timebase),
    timebase: parseFloat(a.header.timebase),
    counts: counts(a).slice(),
    features: copyU8(w, w.engine_view_amps(e), w.engine_view_amps_len(e)),
    times: copyF32(w, w.engine_view_times(e), w.engine_view_times_len(e)),
    labels: copyU16(w, w.engine_view_labels(e), w.engine_view_labels_len(e)),
    indices: copyU32(w, w.engine_view_indices(e), w.engine_view_indices_len(e)),
    waves: copyI8(w, w.engine_sample_waves(e), w.engine_sample_waves_len(e)),
    waveLabels: copyU16(
      w,
      w.engine_sample_labels(e),
      w.engine_sample_labels_len(e),
    ),
    waveIndices: copyU32(
      w,
      w.engine_sample_indices(e),
      w.engine_sample_count(e),
    ),
    headers: currentHeaders,
    undo: s.undo,
    redo: s.redo,
    dirty: s.dirty,
    cached,
    residentBytes: resident(),
    loadMs: a.ms,
  };
}
async function replenishWaves(a: Asset, cell: number) {
  const w = a.wasm,
    e = a.e;
  w.engine_sample_plan(e, cell);
  const wanted = copyU32(
    w,
    w.engine_sample_plan_indices(e),
    w.engine_sample_plan_len(e),
  );
  // Only a bounded plan (<=128 records) crosses this bridge. Rust selects the records
  // and extracts signed channel samples; JS merely performs the browser reads.
  for (let first = 0; first < wanted.length; first += 16)
    await Promise.all(
      [...wanted.subarray(first, first + 16)].map(async (index) => {
        const bytes = new Uint8Array(
            await a.file
              .slice(a.offset + index * 216, a.offset + (index + 1) * 216)
              .arrayBuffer(),
          ),
          p = w.alloc_bytes(216);
        try {
          new Uint8Array(w.memory.buffer, p, 216).set(bytes);
          w.engine_sample_record(e, index, p);
        } finally {
          w.free_bytes(p, 216);
        }
      }),
    );
}
async function waveformColumn(
  a: Asset,
  channel: number,
  sample: number,
  id: number,
) {
  const w = a.wasm,
    e = a.e,
    cached = w.engine_gate_begin(e, channel, sample);
  if (cached < 0) throw new Error("Invalid waveform gate.");
  if (cached) return;
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
async function handle(m: any): Promise<any> {
  if (splitState && !["split", "analysis", "wave_density"].includes(m.type))
    throw new Error(
      "Finish the waveform split with a left click, or press Escape to cancel.",
    );
  if (m.type === "load") {
    await saveActive();
    const key = m.assetKey as string,
      sessionKey = `${key}|${m.cut ? m.cutKey : "unsorted"}`,
      cached = assets.has(key),
      existing = sessions.get(sessionKey);
    budget = m.budget;
    const a = await loadAsset(
      m.file,
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
        if (m.cut) await readCut(m.cut, a.n, a.wasm, a.e);
        else a.wasm.engine_unsorted(a.e);
      }
    } else {
      const stored = await get<Uint16Array>(
        await dbPromise,
        `labels:${sessionKey}`,
      );
      if (stored) labels(a).set(stored);
      else if (s.localCut) throw new Error("Local cut state is unavailable.");
      else if (m.cut) await readCut(m.cut, a.n, a.wasm, a.e);
      else a.wasm.engine_unsorted(a.e);
    }
    a.wasm.engine_recount(a.e);
    active = s;
    activeAsset = a;
    currentHeaders = { tetrode: a.header };
    if (s.localCut)
      currentHeaders.cut = { file: s.localCut.name, source: "Modified cut" };
    else if (m.cut) {
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
    if (m.set) currentHeaders.set = textHeader(await (m.set as File).text());
    if (m.pos)
      currentHeaders.position = parseHeader(
        new Uint8Array(await (m.pos as File).slice(0, 65536).arrayBuffer()),
      ).header;
    return view(a, s, cached);
  }
  if (m.type === "export_cut") {
    const target = sessions.get(m.session);
    if (!target) throw new Error("Cut state is unavailable.");
    if (m.revision !== undefined && target.revision !== m.revision)
      throw new Error("Superseded cut export.");
    if (active?.key === target.key && activeAsset)
      return exportLabels(
        activeAsset.wasm,
        activeAsset.e,
        activeAsset.n,
        m.trial,
        "cut",
      );
    const saved = await get<Uint16Array>(
      await dbPromise,
      `labels:${target.key}`,
    );
    if (!saved || saved.length !== target.n)
      throw new Error("Cut labels are unavailable.");
    const w = await wasmPromise,
      e = w.engine_new_cut(target.n);
    try {
      new Uint16Array(w.memory.buffer, w.engine_labels(e), target.n).set(saved);
      w.engine_recount(e);
      return exportLabels(w, e, target.n, m.trial, "cut");
    } finally {
      w.engine_free(e);
    }
  }
  if (!active || !activeAsset) throw new Error("Load a tetrode first.");
  const a = activeAsset,
    w = a.wasm,
    e = a.e;
  let s = active;
  if (m.session && m.session !== s.key)
    throw new Error("The active cut changed; retry the operation.");
  if (m.type === "clone_cut") {
    await saveActive();
    s = forkSession(s, m.newCut);
    acceptSession(s);
    return view(a, s, true);
  }
  if (m.type === "split") {
    try {
      if (m.phase === "preview") {
        if (!splitState) {
          if (
            !Number.isInteger(m.source) ||
            m.source < 0 ||
            m.source >= 1023 ||
            counts(a)[1023]
          )
            throw new Error("No room to insert another cell.");
          if (!s.localCut) await saveActive();
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
        )
          throw new Error("Invalid waveform split point.");
        if (!w.engine_split_cached(e)) {
          await waveformColumn(a, m.channel, m.sample, m.id);
          w.engine_split_cache_finish(e);
        }
        if (
          w.engine_split_gate(
            e,
            splitState.source,
            m.channel,
            m.sample,
            m.threshold,
          ) < 0
        )
          throw new Error("No room to insert another cell.");
        splitState = {
          ...splitState,
          channel: m.channel,
          sample: m.sample,
          threshold: m.threshold,
        };
        await replenishWaves(a, splitState.source);
        await replenishWaves(a, splitState.source + 1);
      } else if (splitState) {
        if (m.phase === "cancel") w.engine_edit_rollback(e);
        else {
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
      analyses.clear();
      return view(a, s, true);
    } catch (error) {
      w.engine_edit_rollback(e);
      w.engine_patch_clear(e);
      splitState = undefined;
      s.revision++;
      analyses.clear();
      throw error;
    }
  }
  if (m.type === "budget") {
    budget = m.budget;
    return view(a, s, true);
  }
  if (m.type === "edit") {
    if (!Number.isInteger(m.dest) || m.dest < 0 || m.dest >= 1024)
      throw new Error("Destination cell must be 0–1023.");
    if (m.newCut) await saveActive();
    w.engine_edit_begin(e);
    let changed = 0;
    try {
      if (m.action === "sort") w.engine_sort(e);
      else if (m.action === "wave_split") {
        await waveformColumn(a, m.channel, m.sample, m.id);
        if (
          w.engine_split_gate(e, m.source, m.channel, m.sample, m.threshold) < 0
        )
          throw new Error(
            "No room to insert another cell (maximum label 1023).",
          );
      } else if (m.action === "gate") {
        await waveformColumn(a, m.channel, m.sample, m.id);
        withU16(w, m.sources, (p, n) =>
          w.engine_gate_apply(
            e,
            p,
            n,
            m.dest,
            m.channel,
            m.sample,
            m.threshold,
            m.above ? 1 : 0,
          ),
        );
      } else if (m.action === "polygon" || m.action === "paint")
        withU16(w, m.sources, (p, n) =>
          withF32(w, m.polygon, (q, count) =>
            m.action === "paint"
              ? w.engine_brush(e, p, n, m.dest, m.ax, m.ay, q, count)
              : w.engine_polygon(e, p, n, m.dest, m.ax, m.ay, q, count),
          ),
        );
      else w.engine_relabel(e, m.source, m.dest, m.action === "swap" ? 1 : 0);
      changed = w.engine_edit_finish(e);
      if (changed) {
        const entry = {
            id: crypto.randomUUID(),
            description: m.description,
            changed,
          },
          patch = copyU8(w, w.engine_patch(e), w.engine_patch_len(e));
        try {
          await put(await dbPromise, `patch:${entry.id}`, patch);
        } catch (error) {
          throw new Error(
            `Edit rolled back: undo storage is unavailable (${String(error)}).`,
          );
        }
        s = forkSession(s, m.newCut);
        s.undo.push(entry);
        s.redo = [];
        s.dirty = true;
        s.revision++;
        acceptSession(s);
        analyses.clear();
      }
    } catch (error) {
      w.engine_edit_rollback(e);
      throw error;
    } finally {
      w.engine_patch_clear(e);
    }
    if (changed)
      try {
        await replenishWaves(a, m.dest);
      } catch {
        progress(m.id, 1, "Cut saved; waveform sample refresh unavailable.");
      }
    return view(a, s, true);
  }
  if (m.type === "undo" || m.type === "redo") {
    const from = m.type === "undo" ? s.undo : s.redo,
      to = m.type === "undo" ? s.redo : s.undo,
      entry = from.at(-1);
    if (entry) {
      const patch = await get<Uint8Array>(await dbPromise, `patch:${entry.id}`);
      if (!patch) throw new Error("Undo data is unavailable.");
      const p = w.alloc_bytes(patch.byteLength);
      try {
        new Uint8Array(w.memory.buffer, p, patch.byteLength).set(patch);
        if (
          w.engine_patch_apply(
            e,
            p,
            patch.byteLength,
            m.type === "redo" ? 1 : 0,
          )
        )
          throw new Error("Invalid undo data.");
      } finally {
        w.free_bytes(p, patch.byteLength);
      }
      from.pop();
      to.push(entry);
      s.dirty = true;
      s.revision++;
      analyses.clear();
    }
    return view(a, s, true);
  }
  if (m.type === "wave_density") {
    for (const cell of m.cells) await replenishWaves(a, cell);
    withU16(w, m.cells, (p, n) => w.engine_density(e, p, n));
    return {
      texture: copyU16(w, w.engine_density_ptr(e), w.engine_density_len(e)),
      samples: copyU32(w, w.engine_density_sizes(e), m.cells.length),
    };
  }
  if (m.type === "analysis") {
    const opts = m.settings as Settings,
      pk = m.pos
        ? `${m.posKey}|${opts.leds}|${opts.maxSpeed}|${opts.posSmooth}`
        : "";
    let pos = positions.get(pk);
    if (m.pos && !pos) {
      const base = [...positions.values()].find((p) => p.identity === m.posKey);
      pos = await parsePosition(m.pos, opts, w, m.posKey, base);
      positions.set(pk, pos);
      if (positions.size > 4) {
        const oldest = positions.keys().next().value!;
        w.position_free(positions.get(oldest)!.handle);
        positions.delete(oldest);
      }
    }
    const key = `${s.key}|${s.revision}|${m.cell}|${pk}|${opts.binCm}|${opts.smooth}|${opts.acWindow}|${opts.dirBin}|${opts.speedBin}|${opts.speedMax}`;
    const display = (result: any) =>
      m.summary
        ? { ...result, path: new Float32Array(), spikes: new Float32Array() }
        : result;
    if (analyses.has(key)) return display(analyses.get(key));
    const result = analyse(
      w,
      e,
      m.cell,
      parseFloat(a.header.timebase),
      parseFloat(a.header.duration) ||
        (times(a)[a.n - 1] || 0) / parseFloat(a.header.timebase),
      pos,
      opts,
    );
    analyses.set(key, result);
    if (analyses.size > 100) analyses.delete(analyses.keys().next().value!);
    evict(0);
    return display(result);
  }
  if (m.type === "export") return exportLabels(w, e, a.n, m.trial, m.format);

  throw new Error(`Unknown operation: ${m.type}`);
}
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent) => {
  const m = event.data;
  if (m.type === "init") {
    wasmPromise = fetch(m.url)
      .then(async (r) => {
        if (!r.ok)
          throw new Error("Rust/Wasm module missing; run npm run build:wasm.");
        return WebAssembly.instantiate(
          await WebAssembly.compile(await r.arrayBuffer()),
          {},
        );
      })
      .then((x) => x.exports as Core);
    return;
  }
  if (m.type === "load") latestLoad = m.id;
  if (m.type === "analysis" && m.batch) latestAnalysisBatch = m.batch;
  queue = queue.then(async () => {
    try {
      if (m.type === "load" && m.id !== latestLoad)
        throw new Error("Superseded by another recording.");
      if (m.type === "analysis" && m.batch && m.batch !== latestAnalysisBatch)
        throw new Error("Superseded analysis.");
      const data = await handle(m),
        transfer: Transferable[] = [];
      if (data && m.type !== "analysis")
        for (const value of Object.values(data))
          if (ArrayBuffer.isView(value))
            transfer.push(value.buffer as ArrayBuffer);
      self.postMessage({ id: m.id, data }, transfer);
    } catch (error) {
      self.postMessage({
        id: m.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
