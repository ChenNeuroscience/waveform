import { useEffect, useRef, useState } from "react";
import { Check, History, Redo2, Search, Undo2, X } from "lucide-react";
import { DesktopShell } from "./DesktopShell";
import type { DragComparison } from "./tile-gestures";
import { FloatingWindow } from "./FloatingWindow";
import { CellStats, type CellStat } from "./CellStats";
import { captureFeatureGrid } from "./plots";
import { captureTile, type VisiblePlots } from "./TileWall";
import { CutDownloads, cutDownloadKey, writeCutDrag } from "./cut-downloads";
import { usePreference } from "./preferences";
import { organiseFiles } from "./files";
import { request } from "./client";
import { demoFiles } from "./demo";
import {
  color,
  groupTextColor,
  fileId,
  defaultSettings,
  type Settings,
  type Trial,
  type Tetrode,
  type CutFile,
  type ViewData,
  type AnalysisData,
  type PlotMode,
  type SplitPoint,
} from "./types";
const fmt = (n: number) => n.toLocaleString("en-GB");
const compact = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(2)}m`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);
const time = (n: number) =>
  `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`;
function readSettings(): Settings {
  try {
    const saved = JSON.parse(
      localStorage.getItem("waveform-desktop-settings") || "{}",
    );
    return Object.fromEntries(
      Object.entries(defaultSettings).map(([key, value]) => [
        key,
        typeof saved[key] === typeof value &&
        (typeof value !== "number" || Number.isFinite(saved[key]))
          ? saved[key]
          : value,
      ]),
    ) as Settings;
  } catch {
    return defaultSettings;
  }
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
type Pane = "settings" | "history" | "headers" | "help" | null;
type Panel = Exclude<Pane, null>;
export default function App() {
  const [trials, setTrials] = useState<Trial[]>([]),
    [trialId, setTrialId] = useState(""),
    [tetNum, setTetNum] = useState(1),
    [cutId, setCutId] = useState(""),
    [data, setData] = useState<ViewData | null>(null),
    [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [settings, setSettings] = useState<Settings>(readSettings),
    [cell, setCell] = useState(1),
    [sources, setSources] = useState<number[]>([1]),
    [dest, setDest] = useState(2),
    [tool, setTool] = useState("select"),
    [isolate, setIsolate] = usePreference("isolate", false),
    [shown, setShown] = usePreference<VisiblePlots>("plots", {
      waveforms: true,
      spatial: true,
      direction: true,
      speed: true,
      ac: true,
    });
  const [pane, setPane] = useState<Pane>(null),
    [panels, setPanels] = useState<Panel[]>([]),
    [grabMode, setGrabMode] = useState(false),
    [hoverCell, setHoverCell] = useState<number | null>(null),
    [dragComparison, setDragComparison] = useState<DragComparison | null>(null),
    [compareAnalysis, setCompareAnalysis] = useState<{
      key: string;
      data: AnalysisData;
    } | null>(null),
    [splitPoint, setSplitPoint] = useState<SplitPoint | null>(null),
    [copies, setCopies] = useState<
      {
        id: string;
        title: string;
        image: string;
        cell?: number;
        stats?: CellStat[];
        sampled?: boolean;
        x: number;
        y: number;
        width: number;
        height: number;
      }[]
    >([]),
    [downloadVersion, setDownloadVersion] = useState(0),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [drag, setDrag] = useState(false),
    [demo, setDemo] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null),
    folderInput = useRef<HTMLInputElement>(null),
    loadGen = useRef(0),
    analysisGen = useRef(0),
    lastCuts = useRef(new Map<string, string>()),
    dirtySessions = useRef(new Set<string>()),
    finishingSplit = useRef(false),
    cutDownloads = useRef(new CutDownloads());
  useEffect(() => () => cutDownloads.current.dispose(), []);
  useEffect(() => {
    document.title = trials.find((t) => t.id === trialId)?.name
      ? `${trials.find((t) => t.id === trialId)!.name} [Waveform]`
      : "Waveform";
  }, [trialId, trials]);
  const trial = trials.find((t) => t.id === trialId),
    tet = trial?.tetrodes.find((t) => t.number === tetNum),
    cut = tet?.cuts.find((c) => c.id === cutId),
    ready = !!data && !busy;
  useEffect(() => {
    localStorage.setItem("waveform-desktop-settings", JSON.stringify(settings));
  }, [settings]);
  useEffect(() => {
    if (data?.dirty) dirtySessions.current.add(data.session);
    const f = (e: BeforeUnloadEvent) => {
      if (dirtySessions.current.size) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    addEventListener("beforeunload", f);
    return () => removeEventListener("beforeunload", f);
  }, [data?.dirty, data?.session]);
  const importFiles = async (files: File[]) => {
    if (splitPoint) {
      setNotice(
        "Finish the split with a left click, or press Escape before importing files.",
      );
      return;
    }
    try {
      setError("");
      const result = await organiseFiles(files, trials);
      setTrials(result.trials);
      if (!trialId) {
        const first = result.trials.find((t) => t.tetrodes.some((e) => e.file));
        if (first) {
          const e = first.tetrodes.find((e) => e.file)!;
          setTrialId(first.id);
          setTetNum(e.number);
          setCutId(e.cuts[0]?.id || "");
        }
      } else {
        const e = result.trials
          .find((t) => t.id === trialId)
          ?.tetrodes.find((t) => t.number === tetNum);
        if (e && !cutId && e.cuts.length) setCutId(e.cuts[0].id);
      }
    } catch (e) {
      setError(String(e));
    }
  };
  const chooseTrial = (t: Trial) => {
    if (tet) lastCuts.current.set(tet.id, cutId);
    const e =
      t.tetrodes.find((e) => e.number === tetNum && e.file) ||
      t.tetrodes.find((e) => e.file);
    if (!e) return;
    setTrialId(t.id);
    setTetNum(e.number);
    setCutId(lastCuts.current.get(e.id) ?? e.cuts[0]?.id ?? "");
  };
  const chooseTet = (n: number) => {
    const e = trial?.tetrodes.find((t) => t.number === n && t.file);
    if (!e) return;
    if (tet) lastCuts.current.set(tet.id, cutId);
    setTetNum(n);
    setCutId(lastCuts.current.get(e.id) ?? e.cuts[0]?.id ?? "");
  };
  useEffect(() => {
    if (!tet?.file) return;
    if (
      data?.session === `${tet.id}|${fileId(tet.file)}|${cutId || "unsorted"}`
    )
      return;
    const gen = ++loadGen.current;
    setBusy(true);
    setProgress(0);
    setMessage("Opening recording…");
    setDragComparison(null);
    setHoverCell(null);
    setError("");
    setAnalysis(null);
    request(
      "load",
      {
        file: tet.file,
        assetKey: `${tet.id}|${fileId(tet.file)}`,
        cut: cut?.file,
        cutKey: cut?.id,
        set: trial?.set,
        pos: trial?.pos,
        budget: settings.budget,
      },
      (p, m) => {
        if (gen === loadGen.current) {
          setProgress(p);
          setMessage(m);
        }
      },
    )
      .then((d) => {
        if (gen !== loadGen.current) return;
        setData(d);
        const first = d.counts.findIndex((n, i) => n > 0 && i > 0),
          c = first < 0 ? 0 : first;
        setCell(c);
        setSources([c]);
        setDest(d.counts.findIndex((n, i) => n === 0 && i > 0));
        setBusy(false);
      })
      .catch((e) => {
        if (gen === loadGen.current) {
          setError(e.message);
          setBusy(false);
          setData(null);
        }
      });
  }, [tet?.id, tet?.file, cutId]);
  const displayCell = dragComparison?.source ?? hoverCell ?? cell;
  const comparisonKey = `${data?.session}|${data?.revision}|${trial?.id}|${trial?.pos ? fileId(trial.pos) : ""}|${settings.leds}|${settings.maxSpeed}|${settings.posSmooth}|${dragComparison?.target}`;
  useEffect(() => {
    let live = true;
    if (!data || busy || dragComparison?.target == null) return;
    const timeout = setTimeout(
      () =>
        request<AnalysisData>("analysis", {
          session: data.session,
          cell: dragComparison.target,
          pos: trial?.pos,
          posKey: trial?.pos ? `${trial.id}|${fileId(trial.pos)}` : "",
          settings,
        })
          .then((a) => {
            if (live) setCompareAnalysis({ key: comparisonKey, data: a });
          })
          .catch((e) => {
            if (live) setError(e.message);
          }),
      25,
    );
    return () => {
      live = false;
      clearTimeout(timeout);
    };
  }, [comparisonKey, trial?.pos, busy]);
  useEffect(() => {
    if (pane) setPanels((ps) => (ps.includes(pane) ? ps : [...ps, pane]));
  }, [pane]);
  useEffect(() => {
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setGrabMode(false);
    };
    const blur = () => setGrabMode(false);
    addEventListener("keyup", up);
    addEventListener("blur", blur);
    return () => {
      removeEventListener("keyup", up);
      removeEventListener("blur", blur);
    };
  }, []);
  useEffect(() => {
    if (!data || busy) return;
    const gen = ++analysisGen.current;
    const t = setTimeout(
      () =>
        request<AnalysisData>("analysis", {
          session: data.session,
          cell: displayCell,
          pos: trial?.pos,
          posKey: trial?.pos ? `${trial.id}|${fileId(trial.pos)}` : "",
          settings,
        })
          .then((a) => {
            if (gen === analysisGen.current) setAnalysis(a);
          })
          .catch((e) => {
            if (gen === analysisGen.current) setError(e.message);
          }),
      25,
    );
    return () => {
      clearTimeout(t);
      analysisGen.current++;
    };
  }, [
    data,
    displayCell,
    trial?.pos,
    settings.binCm,
    settings.smooth,
    settings.acWindow,
    settings.leds,
    settings.maxSpeed,
    settings.posSmooth,
    settings.dirBin,
    settings.speedBin,
    settings.speedMax,
    busy,
  ]);
  const newCut = () => {
    let n = 1,
      name: string;
    do {
      name = `${trial!.name}_${tetNum} edited${n > 1 ? ` ${n}` : ""}.cut`;
      n++;
    } while (tet!.cuts.some((c) => c.name === name));
    return { id: crypto.randomUUID(), name };
  };
  const adopt = (d: ViewData) => {
    setData(d);
    if (d.localCut) {
      const metadata = d.localCut;
      setTrials((ts) =>
        ts.map((t) =>
          t.id === trial?.id
            ? {
                ...t,
                tetrodes: t.tetrodes.map((e) =>
                  e.id === tet?.id
                    ? {
                        ...e,
                        cuts: [
                          ...e.cuts.filter((c) => c.id !== metadata.id),
                          {
                            ...metadata,
                            file: new File([], metadata.name),
                            local: true,
                            revision: d.revision,
                          },
                        ],
                      }
                    : e,
                ),
              }
            : t,
        ),
      );
      setCutId(metadata.id);
    }
  };
  const prepareCut = async (t: Trial, e: Tetrode, c: CutFile) => {
    try {
      await cutDownloads.current.prepare(t, e, c);
      setDownloadVersion((v) => v + 1);
    } catch (error) {
      if (!String(error).includes("Superseded"))
        setNotice(`Could not prepare ${c.name}: ${String(error)}`);
    }
  };
  useEffect(() => {
    if (!trial || !tet || !cut?.local || busy || splitPoint) return;
    const timer = setTimeout(() => prepareCut(trial, tet, cut), 150);
    return () => clearTimeout(timer);
  }, [cut?.id, cut?.revision, busy, splitPoint]);
  const operation = async (
    type: string,
    payload: Record<string, unknown> = {},
  ) => {
    if (!ready) return;
    const generation = loadGen.current;
    setHoverCell(null);
    setBusy(true);
    setProgress(0);
    setMessage(type === "edit" ? "Updating cut and saving undo…" : `${type}…`);
    try {
      const d = await request(
        type,
        {
          session: data!.session,
          ...(type === "edit" && !cut?.local ? { newCut: newCut() } : {}),
          ...payload,
        },
        (p, m) => {
          if (generation === loadGen.current) {
            setProgress(p);
            setMessage(m);
          }
        },
      );
      if (generation === loadGen.current) adopt(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (generation === loadGen.current) setBusy(false);
    }
  };
  const previewSplit = async (
    source: number,
    channel: number,
    sample: number,
    threshold: number,
  ) => {
    if (!ready || finishingSplit.current) return;
    source = splitPoint?.source ?? source;
    setSplitPoint({ source, channel, sample, threshold });
    setBusy(true);
    setMessage("Preparing split preview…");
    try {
      const d = await request(
        "split",
        {
          session: data!.session,
          phase: "preview",
          source,
          channel,
          sample,
          threshold,
        },
        (p, m) => {
          setProgress(p);
          setMessage(m);
        },
      );
      setData(d);
    } catch (error) {
      setError(String(error));
      setData(
        await request("budget", {
          session: data!.session,
          budget: settings.budget,
        }),
      );
      setSplitPoint(null);
    } finally {
      if (!finishingSplit.current) setBusy(false);
    }
  };
  const finishSplit = async (cancel = false) => {
    if (!splitPoint || finishingSplit.current) return;
    finishingSplit.current = true;
    setBusy(true);
    setHoverCell(null);
    try {
      adopt(
        await request("split", {
          session: data!.session,
          phase: cancel ? "cancel" : "finish",
          ...(!cancel && !cut?.local ? { newCut: newCut() } : {}),
        }),
      );
    } catch (error) {
      setError(String(error));
      setData(
        await request("budget", {
          session: data!.session,
          budget: settings.budget,
        }),
      );
    } finally {
      setSplitPoint(null);
      finishingSplit.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!splitPoint) return;
    const complete = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const swallow = (click: MouseEvent) => {
        click.preventDefault();
        click.stopImmediatePropagation();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 500);
      finishSplit();
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        finishSplit(true);
      }
    };
    window.addEventListener("pointerdown", complete, true);
    window.addEventListener("keydown", cancel, true);
    return () => {
      window.removeEventListener("pointerdown", complete, true);
      window.removeEventListener("keydown", cancel, true);
    };
  }, [splitPoint]);
  const edit = (action: string) => {
    if (!data) return;
    operation("edit", {
      action,
      source: cell,
      dest,
      description: `${action === "swap" ? "Swap" : action === "merge" ? "Merge" : "Move"} cell ${cell} ${action === "swap" ? "↔" : "→"} ${dest}`,
    });
  };
  const polygon = (points: number[], ax: number, ay: number) => {
    if (!sources.length) {
      setNotice("Select one or more source cells in feature space.");
      return;
    }
    operation("edit", {
      action: tool === "brush" ? "paint" : "polygon",
      sources,
      dest,
      ax,
      ay,
      polygon: points,
      description: `${tool === "brush" ? "Brush" : "Lasso"} ${sources.join(", ")} → ${dest}`,
    });
  };
  const exportCut = async (format = "cut") => {
    if (!ready) return;
    try {
      const b = await request<Blob>("export", {
        session: data!.session,
        format,
        trial: trial!.name,
      });
      download(
        b,
        format === "clu"
          ? `${trial!.name}.clu.${tetNum}`
          : `${trial!.name}_${tetNum}.cut`,
      );
      setNotice("Cut exported. Original files are never overwritten.");
    } catch (e) {
      setError(String(e));
    }
  };
  const selectCell = (c: number) => {
    setCell(c);
    setSources([c]);
  };
  const snapshot = () =>
    captureTile(
      cell,
      `${trial?.name} · T${tetNum} · cell ${cell} · ${fmt(data?.counts[cell] || 0)} spikes`,
    );
  const popOut = (n: number, x = 45, y = 70) => {
    const canvas = captureTile(n, "", { header: false, details: false });
    if (!canvas) return;
    const ratio = Math.min(2, devicePixelRatio || 1),
      width = Math.min(innerWidth - 20, Math.max(280, canvas.width / ratio)),
      height = ((width - 2) * canvas.height) / canvas.width + 27,
      stats = [
        ...document.querySelectorAll(
          `.cell-tile[data-cell="${n}"] .caption-inner`,
        ),
      ].map((el) => ({
        label: el.querySelector(".stat-label")?.textContent || "",
        value: el.querySelector(".stat-value")?.textContent || "",
      }));
    setCopies((cs) => [
      ...cs,
      {
        id: crypto.randomUUID(),
        title: `${trial?.name} · T${tetNum} · cell ${n} (copy)`,
        cell: n,
        stats,
        sampled:
          document
            .querySelector(`.cell-tile[data-cell="${n}"]`)
            ?.getAttribute("data-sampled") === "true",
        image: canvas.toDataURL(),
        x: Math.max(0, Math.min(innerWidth - width - 8, x + 15)),
        y: Math.max(0, Math.min(innerHeight - height - 8, y + 15)),
        width,
        height,
      },
    ]);
  };
  const popPlot = (kind: "path" | "features", x: number, y: number) => {
    const source =
      kind === "features"
        ? captureFeatureGrid()
        : document.querySelector<HTMLCanvasElement>(".position-path canvas");
    if (!source) return;
    const ratio = Math.min(2, devicePixelRatio || 1),
      sourceWidth =
        kind === "features" ? source.width / ratio : source.clientWidth,
      width = Math.max(240, Math.min(700, sourceWidth)),
      height = ((width - 2) * source.height) / source.width + 27;
    setCopies((cs) => [
      ...cs,
      {
        id: crypto.randomUUID(),
        title: `${trial?.name} · T${tetNum} · ${kind}`,
        image: source.toDataURL(),
        x: Math.max(0, Math.min(innerWidth - width - 8, x)),
        y: Math.max(0, Math.min(innerHeight - height - 8, y)),
        width,
        height,
      },
    ]);
  };
  const copyPlot = async () => {
    const c = snapshot();
    if (!c) return;
    c.toBlob(async (b) => {
      if (!b) return;
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": b }),
        ]);
        setNotice("Cell plot copied to clipboard.");
      } catch {
        download(b, `cell-${cell}.png`);
        setNotice("Clipboard unavailable; the plot was downloaded.");
      }
    });
  };
  const forkCut = () => operation("clone_cut", { newCut: newCut() });
  const update = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setSettings((s) => ({ ...s, [k]: v }));
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches("input,select,textarea")) return;
      if (dragComparison) {
        e.preventDefault();
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        setGrabMode(true);
        return;
      }
      if (splitPoint) {
        e.preventDefault();
        return;
      }
      const cmd = e.ctrlKey || e.metaKey;
      if (cmd && e.key === "o") {
        e.preventDefault();
        fileInput.current?.click();
        return;
      }
      if (cmd && e.key.toLowerCase() === "z") {
        e.preventDefault();
        operation(e.shiftKey ? "redo" : "undo");
        return;
      }
      if (cmd && e.key === "y") {
        e.preventDefault();
        operation("redo");
        return;
      }
      if (cmd && e.key === "c" && ready) {
        e.preventDefault();
        copyPlot();
        return;
      }
      if (cmd && e.key === "s") {
        e.preventDefault();
        exportCut();
        return;
      }
      if (e.key === "Escape") {
        if (pane) setPanels((ps) => ps.filter((p) => p !== pane));
        setPane(null);
        setTool("select");
        return;
      }
      if (e.key === "k" || e.key === "?")
        setPane((p) => (p === "help" ? null : "help"));
      if (e.key === "h") setPane((p) => (p === "headers" ? null : "headers"));
      if (e.key === "z") setPane((p) => (p === "history" ? null : "history"));
      if (e.key === "d") update("drift", !settings.drift);
      if (e.key === "p") update("density", !settings.density);
      if (e.key === "e") setDest(cell);
      if (e.key === "f")
        setSources(e.shiftKey ? [...new Set([...sources, cell])] : [cell]);
      if (e.key === "l") setTool("lasso");
      if (e.key === "Enter") setDest((d) => Math.min(1023, d + 1));
      if (/^[0-9]$/.test(e.key)) {
        const n = Math.floor(tetNum / 10) * 10 + +e.key;
        chooseTet(n);
      }
      if (e.key === "o") chooseTet(tetNum >= 10 ? tetNum - 10 : tetNum + 10);
      const modes: Record<string, PlotMode> = {
        w: "waveforms",
        r: "spatial",
        c: "direction",
        v: "speed",
        t: "ac",
      };
      if (modes[e.key])
        setShown((s) => ({ ...s, [modes[e.key]]: !s[modes[e.key]] }));
      if (trial && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        const i = trials.indexOf(trial) + (e.key === "ArrowLeft" ? -1 : 1);
        if (trials[i]) chooseTrial(trials[i]);
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });
  const startDemo = async () => {
    setDemo(true);
    setMessage("Creating synthetic demo…");
    await new Promise((r) => setTimeout(r, 20));
    await importFiles(demoFiles());
  };
  const drop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.types.includes("application/x-waveform-cut")) return;
    const entries = Array.from(e.dataTransfer.items)
      .map((i) => i.webkitGetAsEntry?.())
      .filter(Boolean);
    const files: File[] = [];
    const walk = async (entry: any, prefix = ""): Promise<void> => {
      if (entry.isFile) {
        const file: File = await new Promise((resolve, reject) =>
          entry.file(resolve, reject),
        );
        Object.defineProperty(file, "webkitRelativePath", {
          value: prefix + file.name,
        });
        files.push(file);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch: any[] = await new Promise((resolve, reject) =>
            reader.readEntries(resolve, reject),
          );
          if (!batch.length) break;
          for (const child of batch)
            await walk(child, `${prefix}${entry.name}/`);
        }
      }
    };
    if (entries.length) for (const entry of entries) await walk(entry);
    else files.push(...Array.from(e.dataTransfer.files));
    if (files.length) await importFiles(files);
  };
  const renderSettings = () => (
    <>
      <h3>Rendering</h3>
      <Slider
        label="Point size"
        value={settings.pointSize}
        min={0.5}
        max={4}
        step={0.1}
        unit="px"
        onChange={(v) => update("pointSize", v)}
      />
      <label className="field">
        Display budget
        <select
          aria-label="Display budget"
          value={settings.budget}
          onChange={async (e) => {
            const v = +e.target.value;
            update("budget", v);
            if (ready) await operation("budget", { budget: v });
          }}
        >
          {[50000, 100000, 250000, 500000, 1000000].map((n) => (
            <option key={n} value={n}>
              {fmt(n)} points / projection
            </option>
          ))}
        </select>
      </label>
      <Toggle
        label="Colour by recording time"
        checked={settings.drift}
        onChange={(v) => update("drift", v)}
      />
      <Toggle
        label="Density rendering"
        checked={settings.density}
        onChange={(v) => update("density", v)}
      />
      <h3>Spatial & temporal analysis</h3>
      <Slider
        label="Spatial bin width"
        value={settings.binCm}
        min={0.5}
        max={10}
        step={0.5}
        unit="cm"
        onChange={(v) => update("binCm", v)}
      />
      <Slider
        label="Boxcar radius"
        value={settings.smooth}
        min={0}
        max={5}
        step={1}
        unit="bins"
        onChange={(v) => update("smooth", v)}
      />
      <Slider
        label="Rate-map colour maximum (0 = auto)"
        value={settings.maxRate}
        min={0}
        max={50}
        step={1}
        unit="Hz"
        onChange={(v) => update("maxRate", v)}
      />
      <Slider
        label="Autocorrelation window"
        value={settings.acWindow}
        min={20}
        max={1000}
        step={20}
        unit="ms"
        onChange={(v) => update("acWindow", v)}
      />
      <Slider
        label="Direction bin width"
        value={settings.dirBin}
        min={2}
        max={30}
        step={2}
        unit="°"
        onChange={(v) => update("dirBin", v)}
      />
      <Slider
        label="Speed bin width"
        value={settings.speedBin}
        min={1}
        max={10}
        step={1}
        unit="cm/s"
        onChange={(v) => update("speedBin", v)}
      />
      <Slider
        label="Maximum speed shown"
        value={settings.speedMax}
        min={10}
        max={200}
        step={5}
        unit="cm/s"
        onChange={(v) => update("speedMax", v)}
      />
      <h3>Position processing</h3>
      <label className="field">
        Tracked LEDs
        <select
          aria-label="Tracked LEDs"
          value={settings.leds}
          onChange={(e) => update("leds", +e.target.value)}
        >
          <option value="1">One · movement direction</option>
          <option value="2">Two · LED direction</option>
        </select>
      </label>
      <Slider
        label="Jump filter (0 = off)"
        value={settings.maxSpeed}
        min={0}
        max={10}
        step={0.25}
        unit="m/s"
        onChange={(v) => update("maxSpeed", v)}
      />
      <Slider
        label="Position smoothing"
        value={settings.posSmooth}
        min={0}
        max={2}
        step={0.1}
        unit="s"
        onChange={(v) => update("posSmooth", v)}
      />
      <button
        className="secondary"
        onClick={() => setSettings(defaultSettings)}
      >
        Reset settings
      </button>
      <h3>Cut labels</h3>
      <button
        className="secondary"
        disabled={!ready}
        onClick={() =>
          operation("edit", {
            action: "sort",
            dest: 0,
            description: "Renumber cells by spike count (preserve noise 0)",
          })
        }
      >
        Renumber cells by spike count
      </button>
      <p className="muted">
        Largest cell becomes 1. Noise remains 0. This changes the cut and can be
        undone.
      </p>
    </>
  );
  return (
    <DesktopShell
      trials={trials}
      trial={trial}
      tetNum={tetNum}
      cutId={cutId}
      data={data}
      analysis={analysis}
      settings={settings}
      cell={cell}
      sources={sources}
      dest={dest}
      tool={tool}
      isolate={isolate}
      shown={shown}
      grabMode={grabMode}
      hoverCell={hoverCell}
      dragComparison={dragComparison}
      comparisonAnalysis={
        compareAnalysis?.key === comparisonKey ? compareAnalysis.data : null
      }
      onCompare={setDragComparison}
      onHover={setHoverCell}
      onPopOut={popOut}
      onPopPlot={popPlot}
      onMerge={(a, b) => {
        const source = Math.max(a, b),
          dest = Math.min(a, b);
        operation("edit", {
          action: "merge",
          source,
          dest,
          description: `Merge cells ${a} and ${b}`,
        });
        setCell(dest);
        setSources([dest]);
      }}
      splitPoint={splitPoint}
      onWaveSplit={previewSplit}
      busy={busy}
      progress={progress}
      message={message}
      error={error}
      notice={notice}
      drag={drag}
      fileInput={fileInput}
      folderInput={folderInput}
      onImport={importFiles}
      onTrial={chooseTrial}
      onTet={chooseTet}
      onRecording={(t, n, c) => {
        const target = t.tetrodes.find((e) => e.number === n && e.file);
        if (!target) return;
        if (tet) lastCuts.current.set(tet.id, cutId);
        setTrialId(t.id);
        setTetNum(n);
        setCutId(
          c ?? lastCuts.current.get(target.id) ?? target.cuts[0]?.id ?? "",
        );
      }}
      onCut={setCutId}
      downloadVersion={downloadVersion}
      cutDownloads={cutDownloads.current}
      onPrepareCut={prepareCut}
      onCutDrag={(event, t, e, c) => {
        event.stopPropagation();
        const prepared = cutDownloads.current.entries.get(cutDownloadKey(e, c));
        if (!prepared) {
          event.preventDefault();
          prepareCut(t, e, c);
          setNotice(`Preparing ${c.name}. Drag it once it is ready.`);
          return;
        }
        writeCutDrag(event.dataTransfer, prepared);
      }}
      onCell={selectCell}
      onSources={setSources}
      onDest={setDest}
      onTool={setTool}
      onIsolate={setIsolate}
      onToggle={(m) => setShown((s) => ({ ...s, [m]: !s[m] }))}
      onPanel={setPane}
      onOperation={operation}
      onEdit={edit}
      onPolygon={polygon}
      onSettings={update}
      onDemo={startDemo}
      onError={() => setError("")}
      onNotice={() => setNotice("")}
      onDrag={setDrag}
      onDrop={drop}
    >
      {panels.map((pane) => (
        <FloatingWindow
          key={pane}
          preferenceKey={`window:${pane}`}
          grabMode={grabMode}
          label={
            {
              settings: "Settings",
              history: "Edit history",
              headers: "File headers",
              help: "Keyboard shortcuts",
            }[pane]
          }
          title={
            {
              settings: "Settings",
              history: "Edit history",
              headers: "File headers",
              help: "Keyboard shortcuts",
            }[pane]
          }
          x={pane === "headers" ? 410 : 35}
          y={pane === "history" ? 105 : 65}
          height={pane === "settings" ? 560 : 460}
          onFocus={() => setPane(pane)}
          onClose={() => {
            setPanels((ps) => ps.filter((p) => p !== pane));
            setPane(null);
          }}
        >
          <div className="drawer-content">
            {pane === "settings" && renderSettings()}
            {pane === "history" && (
              <>
                <p className="muted">
                  Each cut keeps its own undo and redo history when you switch
                  trials or tetrodes. History is stored locally for this
                  workspace session.
                </p>
                <div className="history-actions">
                  <button
                    disabled={!ready || !data?.undo.length}
                    className="secondary"
                    onClick={() => operation("undo")}
                  >
                    <Undo2 size={14} /> Undo
                  </button>
                  <button
                    disabled={!ready || !data?.redo.length}
                    className="secondary"
                    onClick={() => operation("redo")}
                  >
                    <Redo2 size={14} /> Redo
                  </button>
                </div>
                <div className="history-list">
                  {data?.undo.length ? (
                    data.undo.map((h, i) => (
                      <div key={h.id}>
                        <span className="history-index">{i + 1}</span>
                        <div>
                          <b>{h.description}</b>
                          <small>{fmt(h.changed)} spikes changed</small>
                        </div>
                        <Check size={14} />
                      </div>
                    ))
                  ) : (
                    <div className="empty-history">
                      <History size={27} />
                      <p>No edits yet.</p>
                      <small>
                        Merge, swap, or lasso spikes to start a cut.
                      </small>
                    </div>
                  )}
                  {data?.redo
                    .slice()
                    .reverse()
                    .map((h) => (
                      <div className="undone" key={h.id}>
                        <Redo2 size={13} />
                        <div>
                          <b>{h.description}</b>
                          <small>Undone · available to redo</small>
                        </div>
                      </div>
                    ))}
                </div>
                <button
                  className="primary full"
                  disabled={!ready}
                  onClick={() => exportCut()}
                >
                  Export .cut
                </button>
                <button
                  className="secondary full"
                  disabled={!ready}
                  onClick={forkCut}
                >
                  Duplicate cut
                </button>
                <button
                  className="secondary full"
                  disabled={!ready}
                  onClick={() => exportCut("clu")}
                >
                  Export .clu (1-based)
                </button>
              </>
            )}
            {pane === "headers" && <Headers headers={data?.headers || {}} />}
            {pane === "help" && (
              <>
                <p className="muted">
                  Your files stay on your device. Import a selection of LTX
                  files or a folder to begin. Add cut files at any time.
                </p>
                <h3>Navigation</h3>
                <Shortcut keys="0–9" text="Jump to tetrode (ones digit)" />
                <Shortcut keys="O" text="Toggle tetrode tens digit" />
                <Shortcut keys="← / →" text="Previous / next trial" />
                <Shortcut keys="H" text="Inspect file headers" />
                <Shortcut keys="K / ?" text="Keyboard shortcuts" />
                <h3>Cut editing</h3>
                <Shortcut
                  keys="Drag tile"
                  text="Merge higher cell number into lower"
                />
                <Shortcut
                  keys="Right drag"
                  text="Adjust a split preview from either waveform tile"
                />
                <Shortcut
                  keys="L"
                  text="Lasso source spikes into destination"
                />
                <Shortcut
                  keys="E / F"
                  text="Selected cell as destination / source"
                />
                <Shortcut keys="Enter" text="Next destination cell" />
                <Shortcut keys="⌘ / Ctrl Z" text="Undo" />
                <Shortcut keys="⌘ / Ctrl ⇧ Z" text="Redo" />
                <Shortcut keys="⌘ / Ctrl S" text="Export .cut" />
                <Shortcut keys="⌘ / Ctrl C" text="Copy active cell plots" />
                <h3>Views</h3>
                <Shortcut
                  keys="Hover tile"
                  text="Show cell spikes on the position path"
                />
                <Shortcut
                  keys="Hold Space"
                  text="Click a plot to copy it; click a window to close it"
                />
                <Shortcut
                  keys="W / R / C / V / T"
                  text="Waves / spatial / direction / speed / autocorrelation"
                />
                <Shortcut keys="D / P" text="Time colours / waveform density" />
                <Shortcut keys="Esc" text="Close panel, return to selection" />
                <h3>Reading the plots</h3>
                <p className="muted">
                  Feature space uses a bounded, evenly spaced display sample.
                  Lasso cuts use all spikes from the chosen source cells, across
                  the entire recording; the time sliders affect display only.
                  Waveform traces use a stratified sample. Rate maps use
                  occupancy-normalised rates. Autocorrelation omits the
                  self-spike and uses sampled reference spikes for large groups.
                </p>
                <a
                  href="https://github.com/ChenNeuroscience/waveform"
                  target="_blank"
                  rel="noreferrer"
                >
                  Original project & source ↗
                </a>
              </>
            )}
          </div>
        </FloatingWindow>
      ))}
      {copies.map((c) => (
        <FloatingWindow
          key={c.id}
          grabMode={grabMode}
          title={c.title}
          x={c.x}
          y={c.y}
          width={c.width}
          height={c.height}
          onClose={() => setCopies((cs) => cs.filter((v) => v.id !== c.id))}
        >
          {c.cell !== undefined ? (
            <div className="tile-copy">
              <img
                className="plot-copy"
                src={c.image}
                alt="Copied cell plots"
                draggable={false}
              />
              <span
                className="tile-copy-badge"
                style={{
                  background: color(c.cell),
                  color: groupTextColor(c.cell),
                }}
              >
                {c.cell}
              </span>
              {c.sampled && (
                <span className="sampling-warning">
                  WARNING: using sampled rendering
                </span>
              )}
              <CellStats
                entries={c.stats || []}
                className="tile-copy-stats"
                label="Copied cell statistics"
              />
            </div>
          ) : (
            <img
              className="plot-copy"
              src={c.image}
              alt="Copied plot"
              draggable={false}
            />
          )}
        </FloatingWindow>
      ))}
    </DesktopShell>
  );
}
function Slider({
  label,
  value,
  min,
  max,
  step,
  unit = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (n: number) => void;
}) {
  return (
    <label className="slider-field">
      <span>
        {label}
        <b>
          {Number(value.toFixed(2))} {unit}
        </b>
      </span>
      <input
        aria-label={label}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(+e.target.value)}
      />
    </label>
  );
}
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="toggle-field">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
function Shortcut({ keys, text }: { keys: string; text: string }) {
  return (
    <div className="shortcut">
      <span>{text}</span>
      <kbd>{keys}</kbd>
    </div>
  );
}
function Headers({
  headers,
}: {
  headers: Record<string, Record<string, string>>;
}) {
  const [filter, setFilter] = useState("");
  return (
    <>
      <div className="cell-search">
        <Search size={14} />
        <input
          aria-label="Filter headers"
          placeholder="Filter headers…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {Object.entries(headers).map(([file, h]) => (
        <div key={file}>
          <h3>{file}</h3>
          <dl className="headers-list">
            {Object.entries(h)
              .filter(([k, v]) =>
                `${k} ${v}`.toLowerCase().includes(filter.toLowerCase()),
              )
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
          </dl>
        </div>
      ))}
    </>
  );
}
