import { useEffect, useRef, useState } from "react";
import { DesktopShell } from "./DesktopShell";
import type { DragComparison } from "./tile-gestures";
import { FloatingWindow } from "./FloatingWindow";
import { CellStats, type CellStat } from "./CellStats";
import { captureFeatureGrid } from "./plots";
import { captureTile, type VisiblePlots } from "./TileWall";
import { CutDownloads, cutDownloadKey, writeCutDrag } from "./cut-downloads";
import { usePreference } from "./preferences";
import { useRecordingHistory, type RecordingSelection } from "./navigation";
import { organiseFiles } from "./files";
import { request } from "./client";
import {
  badgeStyle,
  fileId,
  defaultSettings,
  type Settings,
  type Trial,
  type Tetrode,
  type CutFile,
  type ViewData,
  type AnalysisData,
  type Trajectory,
  type PlotMode,
  type SplitPoint,
  type SwapState,
  type TileFeedback,
} from "./types";
import { Superseded, type EditRequest } from "./protocol";
import { TOOL_PANELS, type PanelContext, type PanelName } from "./panels";
import { useShortcuts } from "./shortcuts";
const fmt = (n: number) => n.toLocaleString("en-GB");
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
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
type Pane = PanelName | null;

/** A floating copy of a cell's tile or of a plot (path or feature grid). */
interface PlotCopy {
  id: string;
  title: string;
  image: string;
  cell?: number;
  stats?: CellStat[];
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The worker session key for a tetrode and cut. */
function sessionKey(tet: Tetrode, cutId: string) {
  return `${tet.id}|${fileId(tet.file!)}|${cutId || "unsorted"}`;
}

/** The worker key for a trial's position file, or "" without one. */
function positionKey(trial: Trial | undefined) {
  return trial?.pos ? `${trial.id}|${fileId(trial.pos)}` : "";
}

/** Plot visibility showing only `mode` (as in v1, without Shift). */
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

/** Keep a window of the given size inside the viewport. */
function clampToWindow(x: number, y: number, width: number, height: number) {
  return {
    x: Math.max(0, Math.min(innerWidth - width - 8, x)),
    y: Math.max(0, Math.min(innerHeight - height - 8, y)),
  };
}

export default function App() {
  // Imported files, and the selected trial → tetrode → cut.
  const [trials, setTrials] = useState<Trial[]>([]);
  const [trialId, setTrialId] = useState("");
  const [tetNum, setTetNum] = useState(1);
  const [cutId, setCutId] = useState("");

  // The loaded recording (from the worker) and what the position pane shows.
  const [data, setData] = useState<ViewData | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [trajectory, setTrajectory] = useState<Trajectory | null>(null);

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

  // Tool windows (the focused one is `pane`) and floating plot copies.
  const [pane, setPane] = useState<Pane>(null);
  const [panels, setPanels] = useState<PanelName[]>([]);
  const [copies, setCopies] = useState<PlotCopy[]>([]);
  // Space held: clicking a plot copies it.
  const [grabMode, setGrabMode] = useState(false);

  // Tile interactions: hover, drag-to-compare (with the target's analysis),
  // an open waveform split, a pending swap, and the jiggle after an edit.
  const [hoverCell, setHoverCell] = useState<number | null>(null);
  const [dragComparison, setDragComparison] = useState<DragComparison | null>(null);
  const [compareAnalysis, setCompareAnalysis] = useState<{
    key: string;
    data: AnalysisData;
  } | null>(null);
  const [splitPoint, setSplitPoint] = useState<SplitPoint | null>(null);
  const [swap, setSwap] = useState<SwapState | null>(null);
  const [tileFeedback, setTileFeedback] = useState<TileFeedback | null>(null);

  // Status: busy/progress for worker operations, error and notice banners,
  // files dragged over the page, and a counter that re-renders prepared cuts.
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [drag, setDrag] = useState(false);
  const [downloadVersion, setDownloadVersion] = useState(0);

  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  // Bumped per recording load; async edits, loads and progress updates compare
  // their captured value so replies for a previous recording are ignored.
  const loadGen = useRef(0);
  // The last cut chosen on each tetrode, restored when returning to it.
  const lastCuts = useRef(new Map<string, string>());
  // Sessions with unexported edits, for the leave-page warning.
  const dirtySessions = useRef(new Set<string>());
  // The split finish/cancel in flight, so repeated clicks share one request.
  const finishingSplit = useRef(false);
  const splitCompletion = useRef<Promise<void> | null>(null);
  const cutDownloads = useRef(new CutDownloads());
  // The tile under the pointer (for S to swap), without re-rendering on hover.
  const hoveredTile = useRef<number | null>(null);

  // As in v1: show only the chosen plot; with Shift, toggle it among the others.
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
  // The path is shared by every cell, so it is fetched once per position file and
  // processing settings rather than with each cell's analysis.
  useEffect(() => {
    let live = true;
    if (!data?.key || !trial?.pos) {
      setTrajectory(null);
      return;
    }
    request("trajectory", {
      pos: trial.pos,
      posKey: positionKey(trial),
      settings,
    })
      .then((t) => {
        if (live) {
          setTrajectory(t);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the position-processing settings change the trajectory
  }, [data?.key, trial?.id, trial?.pos, settings.leds, settings.maxSpeed, settings.posSmooth]);
  const displayCell = dragComparison?.source ?? hoverCell ?? cell;
  const comparisonKey = `${data?.session}|${data?.revision}|${trial?.id}|${trial?.pos ? fileId(trial.pos) : ""}|${settings.leds}|${settings.maxSpeed}|${settings.posSmooth}|${dragComparison?.target}`;
  useEffect(() => {
    let live = true;
    const target = dragComparison?.target;
    if (!data || busy || target == null) {
      return;
    }
    const timeout = setTimeout(
      () =>
        request("analysis", {
          session: data.session,
          cell: target,
          pos: trial?.pos,
          posKey: positionKey(trial),
          settings,
        })
          .then((a) => {
            if (live) {
              setCompareAnalysis({ key: comparisonKey, data: a });
            }
          })
          .catch((e) => {
            if (live) {
              setError(e.message);
            }
          }),
      25,
    );
    return () => {
      live = false;
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- comparisonKey covers the comparison's inputs
  }, [comparisonKey, trial?.pos, busy]);
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
    const blur = () => setGrabMode(false);
    addEventListener("keyup", up);
    addEventListener("blur", blur);
    return () => {
      removeEventListener("keyup", up);
      removeEventListener("blur", blur);
    };
  }, []);
  useEffect(() => {
    if (!data || busy) {
      return;
    }
    let live = true;
    const t = setTimeout(
      () =>
        request("analysis", {
          session: data.session,
          cell: displayCell,
          pos: trial?.pos,
          posKey: positionKey(trial),
          settings,
        })
          .then((a) => {
            if (live) {
              setAnalysis(a);
            }
          })
          .catch((e) => {
            if (live && !(e instanceof Superseded)) {
              setError(e.message);
            }
          }),
      25,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the listed analysis settings change the result; trial.id travels with trial.pos
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
  const previewSplit = async (
    source: number,
    channel: number,
    sample: number,
    threshold: number,
  ) => {
    if (!ready || finishingSplit.current) {
      return;
    }
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
      setData(await request("view", { session: data!.session }));
      setSplitPoint(null);
    } finally {
      if (!finishingSplit.current) {
        setBusy(false);
      }
    }
  };
  const finishSplit = (cancel = false): Promise<void> => {
    if (splitCompletion.current) {
      return splitCompletion.current;
    }
    if (!splitPoint) {
      return Promise.resolve();
    }
    const completion = (async () => {
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
        setData(await request("view", { session: data!.session }));
      } finally {
        splitCompletion.current = null;
        setSplitPoint(null);
        finishingSplit.current = false;
        setBusy(false);
      }
    })();
    splitCompletion.current = completion;
    return completion;
  };
  const pushSelection = useRecordingHistory(
    trial && tet?.file ? { trialId, tetNum, cutId } : null,
    async (next, current) => {
      if (splitPoint) {
        await finishSplit(true);
      }
      if (current()) {
        applySelection(next);
      }
    },
  );
  useEffect(() => {
    if (!splitPoint) {
      return;
    }
    const complete = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      // Left presses on either split tile's waveforms adjust the split instead.
      const tile = (event.target as Element | null)
        ?.closest(".tile-waves")
        ?.closest<HTMLElement>(".cell-tile");
      if (tile && [splitPoint.source, splitPoint.source + 1].includes(Number(tile.dataset.cell))) {
        return;
      }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listeners are re-registered per split point; finishSplit reads only values fixed for the split
  }, [splitPoint]);
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
      download(b, `${trial!.name}_${tetNum}.cut`);
      setNotice("Cut exported. Original files are never overwritten.");
    } catch (e) {
      setError(String(e));
    }
  };
  const snapshot = () =>
    captureTile(
      cell,
      `${trial?.name} · T${tetNum} · cell ${cell} · ${fmt(data?.counts[cell] || 0)} spikes`,
    );
  const popOut = (n: number, x = 45, y = 70) => {
    const canvas = captureTile(n, "", { header: false, details: false });
    if (!canvas) {
      return;
    }
    const ratio = Math.min(2, devicePixelRatio || 1);
    const width = Math.min(innerWidth - 20, Math.max(280, canvas.width / ratio));
    const height = ((width - 2) * canvas.height) / canvas.width + 27;
    const stats = [...document.querySelectorAll(`.cell-tile[data-cell="${n}"] .caption-inner`)].map(
      (el) => ({
        label: el.querySelector(".stat-label")?.textContent || "",
        value: el.querySelector(".stat-value")?.textContent || "",
      }),
    );
    setCopies((cs) => [
      ...cs,
      {
        id: crypto.randomUUID(),
        title: `${trial?.name} · T${tetNum} · cell ${n} (copy)`,
        cell: n,
        stats,
        image: canvas.toDataURL(),
        ...clampToWindow(x + 15, y + 15, width, height),
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
    if (!source) {
      return;
    }
    const ratio = Math.min(2, devicePixelRatio || 1);
    const sourceWidth = kind === "features" ? source.width / ratio : source.clientWidth;
    const width = Math.max(240, Math.min(700, sourceWidth));
    const height = ((width - 2) * source.height) / source.width + 27;
    setCopies((cs) => [
      ...cs,
      {
        id: crypto.randomUUID(),
        title: `${trial?.name} · T${tetNum} · ${kind}`,
        image: source.toDataURL(),
        ...clampToWindow(x, y, width, height),
        width,
        height,
      },
    ]);
  };
  const copyPlot = async () => {
    const c = snapshot();
    if (!c) {
      return;
    }
    c.toBlob(async (b) => {
      if (!b) {
        return;
      }
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]);
        setNotice("Cell plot copied to clipboard.");
      } catch {
        download(b, `cell-${cell}.png`);
        setNotice("Clipboard unavailable; the plot was downloaded.");
      }
    });
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
    pane,
    hoverCell,
    hoveredTile,
    settings,
    tetNum,
    trial,
    trials,
    setGrabMode,
    openFiles: () => fileInput.current?.click(),
    operation: (type) => operation(type),
    copyPlot: () => copyPlot(),
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
      const stress = new URLSearchParams(location.search).get("demo") === "stress";
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
  return (
    <DesktopShell
      {...{ trials, trial, tetNum, cutId, data, analysis, trajectory, settings }}
      {...{ cell, sources, dest, tool, isolate, shown, grabMode, hoverCell, dragComparison }}
      {...{ splitPoint, swap, tileFeedback, ready, busy, progress, message, error, notice, drag }}
      {...{ fileInput, folderInput, downloadVersion }}
      comparisonAnalysis={compareAnalysis?.key === comparisonKey ? compareAnalysis.data : null}
      cutDownloads={cutDownloads.current}
      onCompare={setDragComparison}
      onHover={setHoverCell}
      onTileHover={hoverTile}
      onPopOut={popOut}
      onPopPlot={popPlot}
      onMerge={mergeCells}
      onSwapGroup={swapGroup}
      onCancelSwap={() => setSwap(null)}
      onWaveSplit={previewSplit}
      onImport={importFiles}
      onTrial={chooseTrial}
      onTet={chooseTet}
      onRecording={chooseRecording}
      onCut={(id) => navigateTo({ trialId, tetNum, cutId: id })}
      onPrepareCut={prepareCut}
      onCutDrag={dragCut}
      onCell={setCell}
      onSource={selectSource}
      onDest={selectDest}
      onNewGroup={newDestination}
      onTool={setTool}
      onToggle={showPlot}
      onPanel={setPane}
      onOperation={operation}
      onPolygon={polygon}
      onDemo={startDemo}
      onError={() => setError("")}
      onNotice={() => setNotice("")}
      onDrag={setDrag}
      onDrop={drop}
    >
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
      {copies.map((c) => (
        <FloatingWindow
          key={c.id}
          comparison
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
              <img className="plot-copy" src={c.image} alt="Copied cell plots" draggable={false} />
              <span className="tile-copy-badge" style={badgeStyle(c.cell)}>
                {c.cell}
              </span>
              <CellStats
                entries={c.stats || []}
                className="tile-copy-stats"
                label="Copied cell statistics"
              />
            </div>
          ) : (
            <img className="plot-copy" src={c.image} alt="Copied plot" draggable={false} />
          )}
        </FloatingWindow>
      ))}
    </DesktopShell>
  );
}
