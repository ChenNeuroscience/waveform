import { useEffect, useRef, useState } from "react";
import { Toolbar } from "./shell/Toolbar";
import { RenderingToggles } from "./shell/RenderingToggles";
import { FilesPane } from "./shell/FilesPane";
import { PositionPane } from "./shell/PositionPane";
import { FeaturePane, type Painting } from "./shell/FeaturePane";
import { StartScreen } from "./shell/StartScreen";
import { Notice } from "./shell/Notice";
import { FileInputs } from "./shell/FileInputs";
import { Divider, usePaneLayout } from "./shell/panes";
import { SwapPrompt } from "./tiles/SwapPrompt";
import { TilePrompt } from "./tiles/TilePrompt";
import type { DragComparison } from "./tiles/tile-gestures";
import { FloatingWindow } from "./shell/FloatingWindow";
import {
  TileWall,
  type TileActions,
  type TileWallHandle,
  type VisiblePlots,
} from "./tiles/TileWall";
import { PanelTopOpen } from "lucide-react";
import { CutDownloads, cutDownloadKey, writeCutDrag } from "./app/cut-downloads";
import { usePreference } from "./preferences";
import { useRecordingHistory, type RecordingSelection } from "./app/navigation";
import { request } from "./worker/client";
import {
  fileId,
  defaultSettings,
  type Settings,
  type Trial,
  type Tetrode,
  type CutFile,
  type ViewData,
  type PlotMode,
  type SplitPoint,
  type SwapState,
  type TileFeedback,
} from "./types";
import { Superseded, type EditRequest } from "./worker/protocol";
import { TOOL_PANELS, type PanelContext, type PanelName } from "./shell/panels";
import { useShortcuts } from "./app/shortcuts";
import { useAnalyses } from "./app/analyses";
import { useCopies } from "./app/copies";
import { useSplit } from "./app/split";
import { CopyWindow } from "./shell/CopyWindow";
import { downloadBlob, organiseFiles } from "./files";
function readSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem("waveform-desktop-settings") || "{}");
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
type Pane = PanelName | null;

/** The worker session key for a tetrode and cut. */
function sessionKey(tet: Tetrode, cutId: string) {
  return `${tet.id}|${fileId(tet.file!)}|${cutId || "unsorted"}`;
}

/** Plot visibility showing only `mode` (a plain click or key, without Shift). */
function onlyPlot(mode: PlotMode): VisiblePlots {
  return {
    waveforms: false,
    spatial: false,
    direction: false,
    speed: false,
    ac: false,
    [mode]: true,
  };
}

/** The painting sources after clicking `group`: replace, or toggle with Shift. */
function nextSources(current: number[], group: number, toggle: boolean) {
  if (!toggle) {
    return [group];
  }
  return current.includes(group) ? current.filter((n) => n !== group) : [...current, group];
}

/** A cut file name for a new local cut that doesn't clash with existing cuts. */
function editedCutName(trial: Trial, tet: Tetrode) {
  for (let n = 1; ; n++) {
    const name = `${trial.name}_${tet.number} edited${n > 1 ? ` ${n}` : ""}.cut`;
    if (!tet.cuts.some((c) => c.name === name)) {
      return name;
    }
  }
}

/** The trials with a local cut added (or replaced) on one tetrode. */
function withLocalCut(
  trials: Trial[],
  trialId: string | undefined,
  tetId: string | undefined,
  cut: { id: string; name: string },
  revision: number,
): Trial[] {
  const local: CutFile = { ...cut, file: new File([], cut.name), local: true, revision };
  return trials.map((t) =>
    t.id !== trialId
      ? t
      : {
          ...t,
          tetrodes: t.tetrodes.map((e) =>
            e.id !== tetId ? e : { ...e, cuts: [...e.cuts.filter((c) => c.id !== cut.id), local] },
          ),
        },
  );
}

/** Every file in a drop, walking dropped folders and keeping relative paths. */
async function droppedFiles(transfer: DataTransfer) {
  const entries = Array.from(transfer.items)
    .map((i) => i.webkitGetAsEntry?.())
    .filter(Boolean);
  if (!entries.length) {
    return Array.from(transfer.files);
  }
  const files: File[] = [];
  const walk = async (entry: any, prefix = ""): Promise<void> => {
    if (entry.isFile) {
      const file: File = await new Promise((resolve, reject) => entry.file(resolve, reject));
      Object.defineProperty(file, "webkitRelativePath", { value: prefix + file.name });
      files.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch: any[] = await new Promise((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (!batch.length) {
          break;
        }
        for (const child of batch) {
          await walk(child, `${prefix}${entry.name}/`);
        }
      }
    }
  };
  for (const entry of entries) {
    await walk(entry);
  }
  return files;
}

export default function App() {
  // Imported files, and the selected trial → tetrode → cut.
  const [trials, setTrials] = useState<Trial[]>([]);
  const [trialId, setTrialId] = useState("");
  const [tetNum, setTetNum] = useState(1);
  const [cutId, setCutId] = useState("");

  // The loaded recording (from the worker) and what the position pane shows.
  const [data, setData] = useState<ViewData | null>(null);

  // Settings, the selected cell, and the feature-space painting tool
  // (destination ← sources), plus which plots each tile shows.
  const [settings, setSettings] = useState<Settings>(readSettings);
  const [cell, setCell] = useState(1);
  const [sources, setSources] = useState<number[]>([1]);
  const [dest, setDest] = useState(2);
  const [tool, setTool] = useState("brush");
  const [isolate, setIsolate] = usePreference("isolate", false);
  const [shown, setShown] = usePreference<VisiblePlots>("plots", {
    waveforms: true,
    spatial: true,
    direction: true,
    speed: true,
    ac: true,
  });

  // The toolbar (Esc hides and shows it), tool windows (the focused one is `pane`)
  // and floating plot copies.
  const [toolbar, setToolbar] = usePreference("toolbar", true);
  const [pane, setPane] = useState<Pane>(null);
  const [panels, setPanels] = useState<PanelName[]>([]);
  // Space held: clicking a plot copies it.
  const [grabMode, setGrabMode] = useState(false);
  // Whether this window has keyboard focus (shortcuts only reach a focused window).
  const [focused, setFocused] = useState(() => document.hasFocus());

  // Tile interactions: hover, drag-to-compare (with the target's analysis),
  // an open waveform split, a pending swap, and the jiggle after an edit.
  const [hoverCell, setHoverCell] = useState<number | null>(null);
  const [dragComparison, setDragComparison] = useState<DragComparison | null>(null);
  const [splitPoint, setSplitPoint] = useState<SplitPoint | null>(null);
  const [swap, setSwap] = useState<SwapState | null>(null);
  const [tileFeedback, setTileFeedback] = useState<TileFeedback | null>(null);

  // Status: busy/progress for worker operations, error and notice banners, and
  // whether files are being dragged over the page.
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [drag, setDrag] = useState(false);
  // Bumped when a cut file finishes preparing, to re-render its export-ready marker.
  const [, setDownloadVersion] = useState(0);

  const panes = usePaneLayout();
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  // Bumped per recording load; async edits, loads and progress updates compare
  // their captured value so replies for a previous recording are ignored.
  const loadGen = useRef(0);
  // The last cut chosen on each tetrode, restored when returning to it.
  const lastCuts = useRef(new Map<string, string>());
  // Sessions with unexported edits, for the leave-page warning.
  const dirtySessions = useRef(new Set<string>());
  const cutDownloads = useRef(new CutDownloads());
  // The tile under the pointer (for S to swap), without re-rendering on hover.
  const hoveredTile = useRef<number | null>(null);
  const tileWall = useRef<TileWallHandle>(null);

  // Show only the chosen plot; with Shift, toggle it among the others.
  const showPlot = (mode: PlotMode, multiple: boolean) => {
    setShown((s) => (multiple ? { ...s, [mode]: !s[mode] } : onlyPlot(mode)));
  };
  const trial = trials.find((t) => t.id === trialId);
  const tet = trial?.tetrodes.find((t) => t.number === tetNum);
  const cut = tet?.cuts.find((c) => c.id === cutId);
  // The loaded data matches the selection and no operation is running.
  const ready = !!data && !busy && !!tet?.file && data.session === sessionKey(tet, cutId);

  useEffect(() => () => cutDownloads.current.dispose(), []);
  useEffect(() => {
    document.title = trial ? `${trial.name} [Waveform]` : "Waveform";
  }, [trial]);
  useEffect(() => {
    localStorage.setItem("waveform-desktop-settings", JSON.stringify(settings));
  }, [settings]);
  useEffect(() => {
    if (data?.dirty) {
      dirtySessions.current.add(data.session);
    }
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
      setNotice("Finish the split with a left click, or press Escape before importing files.");
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
        if (e && !cutId && e.cuts.length) {
          setCutId(e.cuts[0].id);
        }
      }
    } catch (e) {
      setError(String(e));
    }
  };
  const applySelection = (next: RecordingSelection) => {
    setSwap(null);
    copyMode.end();
    setTileFeedback(null);
    hoveredTile.current = null;
    const target = trials
      .find((t) => t.id === next.trialId)
      ?.tetrodes.find((e) => e.number === next.tetNum && e.file);
    if (!target || (next.cutId && !target.cuts.some((c) => c.id === next.cutId))) {
      return;
    }
    if (trialId === next.trialId && tetNum === next.tetNum && cutId === next.cutId) {
      return;
    }
    if (tet) {
      lastCuts.current.set(tet.id, cutId);
    }
    ++loadGen.current; // Invalidate replies before the next load effect runs.
    setTrialId(next.trialId);
    setTetNum(next.tetNum);
    setCutId(next.cutId);
  };
  const rememberedCut = (target: Tetrode) =>
    target.id === tet?.id ? cutId : (lastCuts.current.get(target.id) ?? target.cuts[0]?.id ?? "");
  const navigateTo = (next: RecordingSelection) => {
    pushSelection(next);
    applySelection(next);
  };
  const chooseTrial = (t: Trial) => {
    const e =
      t.tetrodes.find((e) => e.number === tetNum && e.file) || t.tetrodes.find((e) => e.file);
    if (e) {
      navigateTo({
        trialId: t.id,
        tetNum: e.number,
        cutId: rememberedCut(e),
      });
    }
  };
  const chooseTet = (n: number) => {
    const e = trial?.tetrodes.find((t) => t.number === n && t.file);
    if (e && trial) {
      navigateTo({
        trialId: trial.id,
        tetNum: n,
        cutId: rememberedCut(e),
      });
    }
  };
  useEffect(() => {
    if (!tet?.file) {
      return;
    }
    if (data?.session === sessionKey(tet, cutId)) {
      return;
    }
    const gen = ++loadGen.current;
    setBusy(true);
    setProgress(0);
    setMessage("Opening recording…");
    setDragComparison(null);
    setHoverCell(null);
    setError("");
    clearAnalysis();
    request(
      "load",
      {
        file: tet.file,
        assetKey: `${tet.id}|${fileId(tet.file)}`,
        cut: cut?.file,
        cutKey: cut?.id,
        set: trial?.set,
        pos: trial?.pos,
      },
      (p, m) => {
        if (gen === loadGen.current) {
          setProgress(p);
          setMessage(m);
        }
      },
    )
      .then((d) => {
        if (gen !== loadGen.current) {
          return;
        }
        setData(d);
        const first = d.counts.findIndex((n, i) => n > 0 && i > 0);
        const c = first < 0 ? 0 : first;
        setCell(c);
        // Paint from the lowest populated group (usually noise, 0) into a new group.
        const lowest = d.counts.findIndex((n) => n > 0);
        setSources([lowest < 0 ? 0 : lowest]);
        const empty = d.counts.findIndex((n, i) => n === 0 && i > 0);
        setDest(empty < 0 ? 0 : empty);
        setBusy(false);
      })
      .catch((e) => {
        if (gen === loadGen.current) {
          setError(e.message);
          setBusy(false);
          setData(null);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the tetrode or cut identity changes; other inputs are read at load time
  }, [tet?.id, tet?.file, cutId]);
  const displayCell = dragComparison?.source ?? hoverCell ?? cell;
  const { analysis, trajectory, comparisonAnalysis, clearAnalysis } = useAnalyses({
    data,
    busy,
    trial,
    settings,
    displayCell,
    dragComparison,
    onError: setError,
  });
  const {
    copies,
    popOut,
    popPlot,
    copyToClipboard,
    copyMode,
    close: closeCopy,
    closeAll: closeAllCopies,
  } = useCopies({
    trial,
    trials,
    settings,
    shown,
    rememberedCut,
    tetNum,
    cell,
    data,
    tileWall,
    onNotice: setNotice,
  });
  useEffect(() => {
    if (pane) {
      setPanels((ps) => (ps.includes(pane) ? ps : [...ps, pane]));
    }
  }, [pane]);
  useEffect(() => {
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setGrabMode(false);
      }
    };
    const blur = () => {
      setGrabMode(false);
      setFocused(false);
    };
    const focus = () => setFocused(true);
    addEventListener("keyup", up);
    addEventListener("blur", blur);
    addEventListener("focus", focus);
    return () => {
      removeEventListener("keyup", up);
      removeEventListener("blur", blur);
      removeEventListener("focus", focus);
    };
  }, []);
  const newCut = () => ({ id: crypto.randomUUID(), name: editedCutName(trial!, tet!) });
  // Show a worker view; an edit that created a local cut also adds and selects it.
  const adopt = (d: ViewData) => {
    setData(d);
    if (d.localCut) {
      const localCut = d.localCut;
      setTrials((ts) => withLocalCut(ts, trial?.id, tet?.id, localCut, d.revision));
      setCutId(localCut.id);
    }
  };
  const prepareCut = async (t: Trial, e: Tetrode, c: CutFile) => {
    try {
      await cutDownloads.current.prepare(t, e, c);
      setDownloadVersion((v) => v + 1);
    } catch (error) {
      if (!(error instanceof Superseded)) {
        setNotice(`Could not prepare ${c.name}: ${String(error)}`);
      }
    }
  };
  useEffect(() => {
    if (!trial || !tet || !cut?.local || busy || splitPoint) {
      return;
    }
    const timer = setTimeout(() => prepareCut(trial, tet, cut), 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-prepare only when the local cut or its revision changes
  }, [cut?.id, cut?.revision, busy, splitPoint]);
  // Edits and undo/redo of the active cut; the first edit of an original also
  // names the new local cut.
  const operation = async (type: "edit" | "undo" | "redo", payload: Partial<EditRequest> = {}) => {
    if (!ready) {
      return;
    }
    setSwap(null);
    copyMode.end();
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
        } as EditRequest,
        (p, m) => {
          if (generation === loadGen.current) {
            setProgress(p);
            setMessage(m);
          }
        },
      );
      if (generation === loadGen.current) {
        adopt(d);
        return d as ViewData;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (generation === loadGen.current) {
        setBusy(false);
      }
    }
  };
  const { previewSplit, finishSplit } = useSplit({
    splitPoint,
    setSplitPoint,
    ready,
    session: data?.session,
    newCut: () => (cut?.local ? undefined : newCut()),
    adopt,
    setData,
    onFinishing: () => setHoverCell(null),
    status: { setBusy, setProgress, setMessage, setError },
  });
  // Close every file and return to the start screen.
  const resetToStart = () => {
    ++loadGen.current; // Ignore replies for the closed recording.
    setTrials([]);
    setTrialId("");
    setTetNum(1);
    setCutId("");
    setData(null);
    setBusy(false);
    setSwap(null);
    copyMode.end();
    closeAllCopies();
    setTileFeedback(null);
    setDragComparison(null);
    hoverTile(null);
    setPanels([]);
    setPane(null);
    setError("");
    setNotice("");
    lastCuts.current.clear();
    dirtySessions.current.clear();
  };
  const { push: pushSelection, pushHome } = useRecordingHistory(
    trial && tet?.file ? { trialId, tetNum, cutId } : null,
    async (next, current) => {
      // Back to the start screen loses unexported edits, so ask first.
      if (!next && dirtySessions.current.size) {
        if (!confirm("Close these files? Unexported cut edits will be lost.")) {
          history.forward();
          return;
        }
      }
      if (splitPoint) {
        await finishSplit(true);
      }
      if (!current()) {
        return;
      }
      if (next) {
        applySelection(next);
      } else {
        resetToStart();
      }
    },
  );
  const goHome = async () => {
    if (splitPoint) {
      await finishSplit(true);
    }
    pushHome();
    resetToStart();
  };
  const selectSource = (group: number, toggle = false) => {
    setSources((current) => nextSources(current, group, toggle));
  };
  const selectDest = (group: number) => {
    setDest(group);
    setSources((current) => current.filter((n) => n !== group));
  };
  const newDestination = () => {
    const group = data?.counts.findIndex((count, n) => n > 0 && !count) ?? -1;
    if (group > 0) {
      selectDest(group);
    }
  };
  const swapGroup = async (group: number) => {
    if (!ready || !swap) {
      return;
    }
    const source = swap.source;
    if (source === group) {
      return;
    }
    const result = await operation("edit", {
      action: "swap",
      source,
      dest: group,
      description: `Swap groups ${source} and ${group}`,
    });
    if (result) {
      const remap = (n: number) => (n === source ? group : n === group ? source : n);
      setCell(remap);
      setSources((current) => current.map(remap));
      setDest(remap);
      setTileFeedback({
        id: crypto.randomUUID(),
        session: result.session,
        revision: result.revision,
        cells: [source, group].filter((n) => result.counts[n] > 0),
      });
    }
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
  const exportCut = async () => {
    if (!ready) {
      return;
    }
    try {
      const b = await request("export", {
        session: data!.session,
        format: "cut",
        trial: trial!.name,
      });
      downloadBlob(b, `${trial!.name}_${tetNum}.cut`);
      setNotice("Cut exported. Original files are never overwritten.");
    } catch (e) {
      setError(String(e));
    }
  };
  const update = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setSettings((s) => ({ ...s, [k]: v }));
  // Actions are wrapped so they are looked up when a key is pressed (some are
  // declared further down this component).
  useShortcuts({
    ready,
    dragging: !!dragComparison,
    swap,
    splitPoint,
    copying: !!copyMode.cells,
    pane,
    tool,
    hoverCell,
    hoveredTile,
    settings,
    tetNum,
    cutId,
    trial,
    trials,
    setGrabMode,
    openFiles: () => fileInput.current?.click(),
    operation: (type) => operation(type),
    copyPlot: copyToClipboard,
    startCopyMode: (hovered) => {
      setGrabMode(false);
      copyMode.start(hovered);
    },
    selectAllCopies: () => copyMode.selectAll(),
    endCopyMode: () => copyMode.end(),
    toggleToolbar: () => setToolbar(!toolbar),
    exportCut: () => exportCut(),
    cancelSwap: () => setSwap(null),
    startSwap: (n) => {
      setGrabMode(false);
      setCell(n);
      setSwap({ source: n });
    },
    closePane: () => {
      if (pane) {
        setPanels((ps) => ps.filter((p) => p !== pane));
      }
      setPane(null);
      setTool("brush");
    },
    togglePane: (name) => setPane((p) => (p === name ? null : name)),
    setTool,
    update,
    selectDest: (g) => selectDest(g),
    selectSource: (g, toggle) => selectSource(g, toggle),
    newDestination: () => newDestination(),
    chooseTet: (n) => chooseTet(n),
    chooseTrial: (t) => chooseTrial(t),
    chooseCut: (id) => navigateTo({ trialId, tetNum, cutId: id }),
    showPlot,
  });
  const startDemo = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setMessage("Preparing simulated recordings…");
    try {
      const quick = new URLSearchParams(location.search).get("demo") === "quick";
      const demo = new URLSearchParams(location.search).get("demo");
      const stress = demo === "stress" ? "1m" : demo === "stress-9m" ? "9m" : undefined;
      const seed = quick ? 4271 : crypto.getRandomValues(new Uint32Array(1))[0];
      const files = await request(
        "demo",
        { options: { quick, stress, seed } },
        (value, message) => {
          setProgress(value);
          setMessage(message);
        },
      );
      setBusy(false);
      await importFiles(files);
    } catch (error) {
      setBusy(false);
      setError(String(error));
    }
  };
  const drop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    // Cut files dragged out of the organiser are not imports.
    if (e.dataTransfer.types.includes("application/x-waveform-cut")) {
      return;
    }
    const files = await droppedFiles(e.dataTransfer);
    if (files.length) {
      await importFiles(files);
    }
  };
  const mergeCells = async (a: number, b: number) => {
    const source = Math.max(a, b);
    const dest = Math.min(a, b);
    const result = await operation("edit", {
      action: "merge",
      source,
      dest,
      description: `Merge cells ${a} and ${b}`,
    });
    if (result) {
      setCell(dest);
      setSources([dest]);
      setTileFeedback({
        id: crypto.randomUUID(),
        session: result.session,
        revision: result.revision,
        cells: [dest],
      });
    }
  };
  // Pick a tetrode in a trial; without an explicit cut, restore its last one.
  const chooseRecording = (t: Trial, n: number, c?: string) => {
    const target = t.tetrodes.find((e) => e.number === n && e.file);
    if (target) {
      navigateTo({ trialId: t.id, tetNum: n, cutId: c ?? rememberedCut(target) });
    }
  };
  // Dragging a cut out needs its file ready; start preparing it otherwise.
  const dragCut = (event: React.DragEvent, t: Trial, e: Tetrode, c: CutFile) => {
    event.stopPropagation();
    const prepared = cutDownloads.current.entries.get(cutDownloadKey(e, c));
    if (!prepared) {
      event.preventDefault();
      prepareCut(t, e, c);
      setNotice(`Preparing ${c.name}. Drag it once it is ready.`);
      return;
    }
    writeCutDrag(event.dataTransfer, prepared);
  };
  const hoverTile = (group: number | null) => {
    hoveredTile.current = group;
    setHoverCell(group);
  };
  const closePanel = (name: PanelName) => {
    setPanels((ps) => ps.filter((p) => p !== name));
    setPane(null);
  };
  const panelContext: PanelContext = {
    settings,
    update,
    resetSettings: () => setSettings(defaultSettings),
    isolate,
    setIsolate,
    ready,
    operation: (type) => operation(type),
    renumber: () =>
      operation("edit", {
        action: "sort",
        dest: 0,
        description: "Renumber cells by spike count (preserve noise 0)",
      }),
    history: data,
    headers: data?.headers || {},
  };
  // Files dragged in from outside (not a cut dragged out of the organiser).
  const dragOver = (e: React.DragEvent) => {
    e.preventDefault();
    const types = e.dataTransfer.types;
    if (types.includes("Files") && !types.includes("application/x-waveform-cut")) {
      setDrag(true);
    }
  };
  const openFiles = () => fileInput.current?.click();
  const openFolder = () => folderInput.current?.click();
  const painting: Painting = {
    sources,
    dest,
    tool,
    onSource: selectSource,
    onDest: selectDest,
    onNewGroup: newDestination,
    onTool: setTool,
  };
  const tileActions: TileActions = {
    onSelect: setCell,
    onHover: hoverTile,
    onCompare: setDragComparison,
    onMerge: mergeCells,
    onWaveSplit: previewSplit,
    onPopOut: popOut,
    onSwapGroup: swapGroup,
    onCopyToggle: copyMode.toggle,
  };
  return (
    <div
      className={`app desktop-app ${grabMode ? "grab-mode" : ""} ${splitPoint ? "splitting" : ""} ${focused ? "" : "unfocused"}`}
      data-ready={ready ? "true" : "false"}
      onDragOver={dragOver}
      onDragLeave={(e) => !e.relatedTarget && setDrag(false)}
      onDrop={drop}
    >
      <FileInputs fileInput={fileInput} folderInput={folderInput} onImport={importFiles} />
      {trials.length > 0 ? (
        <>
          {toolbar ? (
            <Toolbar
              {...{ data, ready, busy, progress, message, shown }}
              unexported={dirtySessions.current.size > 0}
              onHome={goHome}
              onOpenFiles={openFiles}
              onOpenFolder={openFolder}
              onOperation={operation}
              onPanel={setPane}
              onToggle={showPlot}
            >
              <RenderingToggles
                drift={settings.drift}
                density={settings.density}
                onToggle={(mode) => update(mode, !settings[mode])}
              />
            </Toolbar>
          ) : (
            <button
              className="toolbar-show"
              title="Show toolbar [Esc]"
              aria-label="Show toolbar"
              onClick={() => setToolbar(true)}
            >
              <PanelTopOpen size={16} />
            </button>
          )}
          <div
            className="desktop-workspace"
            ref={panes.workspace}
            style={{ gridTemplateColumns: panes.columns }}
          >
            <div
              className="left-workspace"
              ref={panes.left}
              style={{ gridTemplateRows: panes.rows }}
            >
              <FilesPane
                {...{ trials, trial, tetNum, cutId }}
                cutDownloads={cutDownloads.current}
                onTrial={chooseTrial}
                onTet={chooseTet}
                onRecording={chooseRecording}
                onPrepareCut={prepareCut}
                onCutDrag={dragCut}
                copying={copyMode.cells !== null}
                copyTrialIds={copyMode.trialIds}
                onCopyTrial={copyMode.toggleTrial}
                copyCuts={copyMode.cuts}
                onCopyCut={copyMode.chooseCut}
              />
              <Divider part="files" onDrag={panes.dragDivider} />
              <PositionPane
                {...{ data, trial, settings, trajectory, analysis, comparisonAnalysis }}
                {...{ hoverCell, dragComparison, grabMode }}
                onPopPlot={popPlot}
              />
              <Divider part="position" onDrag={panes.dragDivider} />
              <FeaturePane
                {...{ data, settings, cell, isolate, painting, grabMode }}
                canPaint={ready && !swap}
                splitting={!!splitPoint}
                onHover={setHoverCell}
                onPolygon={polygon}
                onPopPlot={popPlot}
              />
            </div>
            <Divider part="columns" onDrag={panes.dragDivider} />
            <section className="right-workspace">
              {swap && data && (
                <SwapPrompt
                  state={swap}
                  counts={data.counts}
                  onGroup={swapGroup}
                  onCancel={() => setSwap(null)}
                />
              )}
              {splitPoint && (
                <TilePrompt
                  label="Split cell"
                  instructions={`Split cell ${splitPoint.source}: right-drag either waveform to move the gate. Click elsewhere to finish, Esc to cancel.`}
                />
              )}
              {dragComparison && (
                <TilePrompt
                  label="Merge cells"
                  instructions={
                    dragComparison.target === null
                      ? `Merge cell ${dragComparison.source}: drop it on another tile. Esc to cancel.`
                      : `Release to merge cells ${dragComparison.source} and ${dragComparison.target}. Esc to cancel.`
                  }
                />
              )}
              {copyMode.cells && (
                <TilePrompt
                  label="Copy cells"
                  instructions={
                    copyMode.trialIds.length > 1
                      ? `Copy mode: ${copyMode.cells.length} cells across ${copyMode.trialIds.length} trials. Click tiles or trials to toggle them. Esc to finish.`
                      : `Copy mode: click tiles to add or remove them (${copyMode.cells.length} ${copyMode.cells.length === 1 ? "cell" : "cells"} on the clipboard). Click more trials to compare. Esc to finish.`
                  }
                >
                  {copyMode.preparing && <div role="status">Preparing clipboard…</div>}
                  <button type="button" onClick={copyMode.selectAll}>
                    Select all [⌘/Ctrl A]
                  </button>
                  <button type="button" onClick={copyMode.end}>
                    Done [Esc]
                  </button>
                </TilePrompt>
              )}
              {data ? (
                <TileWall
                  ref={tileWall}
                  copying={copyMode.cells}
                  {...{ data, settings, trial, shown, splitPoint, swap, grabMode }}
                  selected={cell}
                  feedback={tileFeedback}
                  busy={!ready}
                  actions={tileActions}
                />
              ) : (
                <div className="pane-placeholder">{message || "Loading recording…"}</div>
              )}
            </section>
          </div>
        </>
      ) : (
        <StartScreen
          {...{ busy, progress, message, drag }}
          onOpenFiles={openFiles}
          onOpenFolder={openFolder}
          onDemo={startDemo}
        />
      )}
      <Notice
        error={error}
        notice={notice}
        onDismiss={() => (error ? setError("") : setNotice(""))}
      />
      {drag && trials.length > 0 && (
        <div className="drag-overlay">
          <p className="drop-title-wobble">drag &amp; drop files here</p>
          <small>.set · .pos · .1, .2, … · .cut · .clu.N</small>
        </div>
      )}
      {panels.map((name) => {
        const panel = TOOL_PANELS[name];
        return (
          <FloatingWindow
            key={name}
            preferenceKey={`window:${name}`}
            grabMode={grabMode}
            label={panel.title}
            title={panel.title}
            x={panel.x}
            y={panel.y}
            height={panel.height}
            onFocus={() => setPane(name)}
            onClose={() => closePanel(name)}
          >
            <div className="drawer-content">{panel.render(panelContext)}</div>
          </FloatingWindow>
        );
      })}
      {copies.map((copy) => (
        <CopyWindow
          key={copy.id}
          copy={copy}
          grabMode={grabMode}
          onClose={() => closeCopy(copy.id)}
        />
      ))}
    </div>
  );
}
