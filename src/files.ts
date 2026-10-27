import { fileId, type Trial, type Header } from "./types";
export function textHeader(text: string): Header {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((l) => l.trim().match(/^(\S+)\s+(.+)$/))
      .filter(Boolean)
      .map((m) => [m![1], m![2]]),
  );
}
export function parseHeader(bytes: Uint8Array): {
  header: Header;
  offset: number;
} {
  const marker = new TextEncoder().encode("data_start");
  let offset = -1;
  outer: for (let i = 0; i <= bytes.length - marker.length; i++) {
    if (i && bytes[i - 1] !== 10) {
      continue;
    }
    for (let j = 0; j < marker.length; j++) {
      if (bytes[i + j] !== marker[j]) {
        continue outer;
      }
    }
    offset = i + marker.length;
    break;
  }
  if (offset < 0) {
    throw new Error("Missing data_start marker in LTX header.");
  }
  return {
    header: textHeader(new TextDecoder("latin1").decode(bytes.subarray(0, offset - marker.length))),
    offset,
  };
}
export async function organiseFiles(
  files: File[],
  previous: Trial[] = [],
): Promise<{ trials: Trial[]; ignored: string[] }> {
  // File objects are immutable. Preserve their references and relative paths while
  // cloning only the mutable organiser containers (custom paths do not clone).
  const trials: Trial[] = previous.map((t) => ({
    ...t,
    otherFiles: [...(t.otherFiles || [])],
    tetrodes: t.tetrodes.map((e) => ({ ...e, cuts: [...e.cuts] })),
  }));
  const map = new Map(trials.map((t) => [t.id, t]));
  const ignored: string[] = [];
  const skipped: { file: File; detail: string }[] = [];
  const cuts: File[] = [];
  const ignore = (file: File, reason = "") => {
    const detail = file.name + (reason ? ` (${reason})` : "");
    ignored.push(detail);
    skipped.push({ file, detail });
  };
  const ensure = (base: string, folder: string) => {
    const id = `${folder}/${base}`;
    if (!map.has(id)) {
      const t: Trial = { id, name: base, folder, tetrodes: [] };
      map.set(id, t);
      trials.push(t);
    }
    return map.get(id)!;
  };
  const tet = (t: Trial, n: number) => {
    let v = t.tetrodes.find((x) => x.number === n);
    if (!v) {
      v = { id: `${t.id}.${n}`, number: n, cuts: [] };
      t.tetrodes.push(v);
    }
    return v;
  };
  for (const f of files) {
    const m = f.name.match(/^(.*)\.([^.]+)$/);
    const folder = (f.webkitRelativePath || "").split("/").slice(0, -1).join("/");
    if (!m) {
      ignore(f);
      continue;
    }
    const [, base, raw] = m;
    const ext = raw.toLowerCase();
    if (ext === "cut" || /\.clu\.\d+$/i.test(f.name)) {
      if (!/\.temp\.clu\./i.test(f.name)) {
        cuts.push(f);
      } else {
        ignore(f);
      }
      continue;
    }
    if (ext === "pos" || ext === "set") {
      ensure(base, folder)[ext] = f;
    } else if (/^\d+$/.test(ext) && +ext > 0 && !/\.(fet|fmask|klg|res|spk|temp)$/i.test(base)) {
      tet(ensure(base, folder), +ext).file = f;
    } else {
      ignore(f);
    }
  }
  for (const f of cuts) {
    const folder = (f.webkitRelativePath || "").split("/").slice(0, -1).join("/");
    let base: string | undefined;
    let n: number | undefined;
    const clu = f.name.match(/^(.*)\.clu\.(\d+)$/i);
    if (clu) {
      base = clu[1];
      n = +clu[2];
    } else {
      const m = f.name.match(/^(.*?)[_.](\d+)[a-zA-Z0-9 _.-]*\.cut$/i);
      if (m) {
        base = m[1];
        n = +m[2];
      }
      const head = await f.slice(0, 65536).text();
      const embedded = head.match(/Exact_cut_for:\s*(.*?)\s+spikes:/);
      if (embedded) {
        const candidate = embedded[1].replace(/^.*[\\/]/, "").replace(/\.\d+$/, "");
        if (!base || !map.has(`${folder}/${base}`)) {
          base = candidate;
        }
      }
    }
    if (!base || !n) {
      ignore(f, "cannot identify trial/tetrode");
      continue;
    }
    const candidates = trials.filter((t) => t.name === base);
    if (!folder && !map.has(`/${base}`) && candidates.length > 1) {
      ignore(f, "ambiguous trial; import with its folder");
      continue;
    }
    const owner =
      !folder && !map.has(`/${base}`) && candidates.length === 1
        ? candidates[0]
        : ensure(base, folder);
    const target = tet(owner, n);
    const id = fileId(f);
    if (!target.cuts.some((c) => c.id === id)) {
      target.cuts.push({ id, file: f, name: f.name });
    }
  }
  // Associate auxiliary names after grouping, independent of input ordering.
  // Keep only names: skipped multi-GB files need no retained handles or reads.
  for (const { file, detail } of skipped) {
    const folder = (file.webkitRelativePath || "").split("/").slice(0, -1).join("/");
    const owner = trials
      .filter(
        (t) =>
          t.folder === folder &&
          (file.name.startsWith(t.name + ".") || file.name.startsWith(t.name + "_")),
      )
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (owner) {
      owner.otherFiles = [...new Set([...(owner.otherFiles || []), detail])].sort();
    }
  }
  trials.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  for (const t of trials) {
    t.tetrodes.sort((a, b) => a.number - b.number);
    for (const e of t.tetrodes) {
      e.cuts.sort((a, b) => b.file.lastModified - a.file.lastModified);
    }
  }
  return { trials, ignored };
}
/** Browser I/O bridge: label tokenisation and validation happen inside Rust. */
export async function readCut(
  file: File,
  n: number,
  wasm: import("./worker/wasm").Core,
  engine: number,
): Promise<void> {
  const clu = /\.clu\.\d+$/i.test(file.name);
  let start = 0;
  if (!clu) {
    const head = new TextDecoder("latin1").decode(await file.slice(0, 65536).arrayBuffer());
    const m = /Exact_cut_for:\s*(.*?)\s+spikes:\s*(\d+)/.exec(head);
    if (!m) {
      throw new Error(`${file.name}: missing Exact_cut_for / spikes header.`);
    }
    if (+m[2] !== n) {
      throw new Error(`${file.name}: ${m[2]} labels declared, but tetrode has ${n} spikes.`);
    }
    start = m.index + m[0].length;
  }
  const errors: Record<number, string> = {
    [-1]: "Invalid character in cut labels.",
    [-2]: "Cut contains too many labels.",
    [-3]: "Cell labels must be 0–1023 (CLu is 1-based).",
    [-4]: "Cut contains too few labels.",
    [-5]: "Cut label integer overflow.",
  };
  const chunk = 1 << 20;
  const p = wasm.alloc_bytes(chunk);
  wasm.engine_cut_begin(engine, clu ? 1 : 0);
  try {
    for (let first = start; first < file.size; first += chunk) {
      const bytes = new Uint8Array(await file.slice(first, first + chunk).arrayBuffer());
      new Uint8Array(wasm.memory.buffer, p, bytes.length).set(bytes);
      const status = wasm.engine_cut_feed(engine, p, bytes.length);
      if (status) {
        throw new Error(`${file.name}: ${errors[status]}`);
      }
    }
    const status = wasm.engine_cut_finish(engine);
    if (status) {
      throw new Error(`${file.name}: ${errors[status]}`);
    }
  } finally {
    wasm.engine_cut_abort(engine);
    wasm.free_bytes(p, chunk);
  }
}
